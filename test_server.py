"""Self-check: python test_server.py  (needs ffmpeg on PATH)"""
import json
import struct
import subprocess
import tempfile
import threading
import urllib.request
import zlib
from http.server import ThreadingHTTPServer
from pathlib import Path

import server


def png(w, h, rgb):
    raw = b"".join(b"\0" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def call(base, method, path, body=b""):
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, body or None, method=method)) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    root = Path(tempfile.mkdtemp())
    (root / "frames").mkdir()
    server.Handler.root = root
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"

    # upload never overwrites, names sanitized
    a = json.loads(call(base, "POST", "/api/upload?name=..%2F..%2Fevil.png", png(8, 8, (255, 0, 0)))[1])["file"]
    b = json.loads(call(base, "POST", "/api/upload?name=evil.png", png(8, 8, (0, 255, 0)))[1])["file"]
    assert a == "frames/evil.png" and b == "frames/evil_1.png", (a, b)
    assert call(base, "POST", "/api/upload?name=x.exe", b"x")[0] == 400

    # path traversal blocked
    assert call(base, "GET", "/p/../server.py")[0] == 404
    assert call(base, "GET", "/p/%2e%2e/%2e%2e/etc/passwd")[0] == 404
    assert call(base, "GET", "/p/" + a)[0] == 200

    # project round-trip
    assert json.loads(call(base, "GET", "/api/project")[1])["frames"] == [{"file": a}, {"file": b}]
    proj = {"canvas": {"width": 8, "height": 8}, "fps": 12, "frames": [{"file": a, "x": 1}, {"file": b, "x": -1}]}
    assert call(base, "PUT", "/api/project", proj)[0] == 200
    assert json.loads(call(base, "GET", "/api/project")[1]) == proj

    # export + encode all formats
    for i in (1, 2):
        assert call(base, "POST", f"/api/export/frame?i={i}", png(8, 8, (0, 0, 255 * (i - 1))))[0] == 200
    seq = [{"i": 1, "duration": 100}, {"i": 2, "duration": 250}]
    st, body = call(base, "POST", "/api/export/encode", {"formats": ["gif", "mp4", "webm"], "sequence": seq})
    assert st == 200, body
    for f in ("gif", "mp4", "webm"):  # total length must match the per-frame durations (350 ms)
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "frame=duration_time", "-of", "csv=p=0",
                              str(root / "output" / f"anim.{f}")], capture_output=True, text=True).stdout.split()
        total = sum(float(x.strip(",")) for x in out)
        assert abs(total - 0.35) < 0.02, (f, out)
    print("ok", root)


if __name__ == "__main__":
    main()
