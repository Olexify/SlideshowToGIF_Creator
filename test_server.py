"""Self-check: python test_server.py  (needs ffmpeg on PATH)"""
import json
import os
import time
import struct
import subprocess
import tempfile
import threading
import urllib.request
import zlib
from pathlib import Path

import server


def png(w, h, rgb):
    raw = b"".join(b"\0" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def main():
    tmp = Path(tempfile.mkdtemp())
    data, originals, out = tmp / "app", tmp / "my images", tmp / "out"
    originals.mkdir()
    for i in (1, 2):
        (originals / f"frame_{i}.png").write_bytes(png(8, 8, (40 * i, 0, 0)))
    (tmp / "secret.png").write_bytes(png(1, 1, (0, 0, 0)))

    # v1 single-project folder gets migrated into projects/
    (data / "project" / "frames").mkdir(parents=True)
    (data / "project" / "frames" / "old.png").write_bytes(png(2, 2, (1, 2, 3)))
    (data / "project" / "project.json").write_text(json.dumps({"frames": [{"file": "frames/old.png"}]}))
    server.DATA = data
    server.migrate_old_project()
    (data / "projects").mkdir(exist_ok=True)
    [old] = server.list_projects()
    assert server.load_project(old["id"])["frames"][0]["file"] == "files/old.png" and not (data / "project").exists()

    srv = server.Server(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"

    def call(method, path, body=b"", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        req = urllib.request.Request(base + path, body or None, method=method,
                                     headers={"X-Frame-Aligner": "1", **(headers or {})})
        try:
            with urllib.request.urlopen(req) as r:
                raw = r.read()
                return r.status, json.loads(raw) if r.headers.get_content_type() == "application/json" else raw
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    # other websites can't change anything (no custom header) or rebind DNS (Host check)
    assert call("POST", "/api/projects", {"name": "x"}, {"X-Frame-Aligner": ""})[0] == 403
    assert call("GET", "/api/projects", headers={"Host": "evil.example"})[0] == 403

    st, j = call("POST", "/api/projects", {"name": "Fox walk"})
    pid = j["id"]
    assert {p["name"] for p in call("GET", "/api/projects")[1]} == {"Fox walk", "My first project"}

    # picking links originals in place (no copy) ...
    server.native_pick = lambda folder, initial: sorted(str(p) for p in originals.iterdir())
    st, j = call("POST", f"/api/p/{pid}/pick", {"folder": True})
    linked = j["files"]
    assert linked == [str(originals / "frame_1.png"), str(originals / "frame_2.png")], j
    assert not (data / "projects" / pid / "files").exists()
    assert call("GET", f"/api/p/{pid}/img?f=" + urllib.request.quote(linked[0]))[0] == 200
    # ... and only project images are served
    assert call("GET", f"/api/p/{pid}/img?f=" + urllib.request.quote(str(tmp / "secret.png")))[0] == 404
    assert call("GET", f"/api/p/{pid}/img?f=" + urllib.request.quote("../../settings.json"))[0] == 404
    assert call("GET", f"/api/p/{pid}/img?f=files/../../../secret.png")[0] == 404

    # "keep copies" copies picked files into the project
    call("PUT", "/api/settings", {"copyImports": True})
    st, j = call("POST", f"/api/p/{pid}/pick", {})
    assert j["files"] == ["files/frame_1.png", "files/frame_2.png"], j
    call("PUT", "/api/settings", {"copyImports": False})

    # dropped files are copied, never overwriting
    a = call("POST", f"/api/p/{pid}/upload?name=..%2Fevil.png", png(8, 8, (9, 9, 9)))[1]["file"]
    b = call("POST", f"/api/p/{pid}/upload?name=evil.png", png(8, 8, (9, 9, 9)))[1]["file"]
    assert (a, b) == ("files/evil.png", "files/evil (2).png"), (a, b)
    assert call("POST", f"/api/p/{pid}/upload?name=x.exe", b"x")[0] == 400

    # copies nothing refers to are pruned when the project is opened
    call("PUT", f"/api/p/{pid}", {"name": "Fox walk", "frames": [{"file": a}]})
    call("GET", f"/api/p/{pid}")
    assert (data / "projects" / pid / b).exists()  # too fresh to prune
    for f in (data / "projects" / pid / "files").iterdir():
        os.utime(f, (time.time() - 3600,) * 2)
    call("GET", f"/api/p/{pid}")
    assert (data / "projects" / pid / a).exists() and not (data / "projects" / pid / b).exists()

    # save / load
    proj = {"name": "Fox walk", "canvas": {"width": 8, "height": 8}, "fps": 12,
            "frames": [{"file": linked[0], "x": 1}, {"file": linked[1], "x": -1}]}
    assert call("PUT", f"/api/p/{pid}", proj)[0] == 200 and call("GET", f"/api/p/{pid}")[1] == proj

    # export into a chosen folder, with exact durations; renders are cleaned up; existing files are kept
    call("PUT", "/api/settings", {"exportMode": "custom", "exportCustom": str(out)})
    out.mkdir()
    (out / "Fox walk.gif").write_bytes(b"user file")
    for i in (1, 2):
        assert call("POST", f"/api/p/{pid}/export/frame?i={i}", png(8, 8, (0, 0, 255 * (i - 1))))[0] == 200
    seq = [{"i": 1, "duration": 100}, {"i": 2, "duration": 250}]
    st, j = call("POST", f"/api/p/{pid}/export/finish", {"formats": ["gif", "mp4", "webm"], "png": True, "sequence": seq})
    assert st == 200, j
    assert (out / "Fox walk.gif").read_bytes() == b"user file"
    assert sorted(Path(p).name for p in j["outputs"]) == ["Fox walk (2).gif", "Fox walk frames", "Fox walk.mp4", "Fox walk.webm"]
    for f in j["outputs"]:
        if Path(f).is_dir():
            assert sorted(p.name for p in Path(f).iterdir()) == ["frame_0001.png", "frame_0002.png"]
            continue
        durs = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "frame=duration_time", "-of", "csv=p=0", f],
                              capture_output=True, text=True).stdout.split()
        assert abs(sum(float(x.strip(",")) for x in durs) - 0.35) < 0.02, (f, durs)
    assert not (data / "projects" / pid / "render").exists()

    # clear keeps the project, drops frames and copies; originals untouched
    assert call("POST", f"/api/p/{pid}/clear")[0] == 200
    assert call("GET", f"/api/p/{pid}")[1]["frames"] == [] and not (data / "projects" / pid / "files").exists()
    # delete others, then delete
    call("POST", "/api/projects/delete-others", {"keep": pid})
    assert [p["id"] for p in call("GET", "/api/projects")[1]] == [pid]
    call("POST", f"/api/p/{pid}/delete")
    assert call("GET", "/api/projects")[1] == [] and call("GET", f"/api/p/{pid}")[0] == 404
    assert sorted(p.name for p in originals.iterdir()) == ["frame_1.png", "frame_2.png"]
    print("ok", tmp)


if __name__ == "__main__":
    main()
