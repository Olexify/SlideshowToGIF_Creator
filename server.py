"""Frame alignment workstation: local server.

Usage: python server.py [project_dir] [--port 8765] [--no-browser]

project_dir layout:
  frames/          source PNGs (never modified)
  project.json     transforms, order, durations (autosaved by the editor)
  output/aligned/  aligned PNG sequence (written on export)
  output/anim.*    encoded GIF / MP4 / WebM
"""
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

STATIC = Path(__file__).parent / "static"
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
FORMATS = {
    "gif": ["-fps_mode", "vfr", "-vf", "split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse", "-loop", "0"],
    # video: constant 60 fps, per-frame holds become duplicated frames (cheap to encode)
    "mp4": ["-vf", "fps=60,pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16"],
    "webm": ["-vf", "fps=60", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "20"],
}


def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def list_frames(root):
    d = root / "frames"
    if not d.is_dir():
        return []
    return sorted((f"frames/{p.name}" for p in d.iterdir() if p.suffix.lower() in IMAGE_EXT), key=natural_key)


def safe_name(name):
    name = re.sub(r"[^\w.\- ]", "_", os.path.basename(name)).strip(" .")
    return name or "frame.png"


def write_json_atomic(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def encode(root, sequence, fmt):
    """sequence: [{"i": 1-based aligned frame index, "duration": ms}] -> output/anim.<fmt>"""
    aligned = root / "output" / "aligned"
    lines, secs = [], [max(float(s["duration"]), 10) / 1000 for s in sequence]
    for s, d in zip(sequence, secs):
        # framerate 1000 = 1 ms timebase; image2's default 25 fps would quantize durations to 40 ms
        lines += [f"file 'frame_{int(s['i']):04d}.png'", "option framerate 1000", f"duration {d:.4f}"]
    lines += lines[-3:-1]  # repeat last file so its duration is honoured
    (aligned / "list.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    out = root / "output" / f"anim.{fmt}"
    # the muxers don't know the last frame's length on their own: cap it explicitly
    end = (["-frames:v", str(len(sequence)), "-final_delay", str(round(secs[-1] * 100))] if fmt == "gif"
           else ["-t", f"{sum(secs):.4f}"])
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
           "-i", str(aligned / "list.txt"), *FORMATS[fmt], *end, str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or f"ffmpeg failed ({fmt})")
    return out


class Handler(SimpleHTTPRequestHandler):
    root: Path  # project dir, set in main()

    def log_message(self, *a):
        pass

    def send_json(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def serve_file(self, base, rel):
        base = base.resolve()
        p = (base / unquote(rel)).resolve()
        if base not in p.parents or not p.is_file():
            return self.send_error(404)
        ctype = self.guess_type(str(p))
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/favicon.ico":
            return self.serve_file(STATIC, "icon.ico")
        if url.path == "/":
            return self.serve_file(STATIC, "index.html")
        if url.path.startswith("/static/"):
            return self.serve_file(STATIC, url.path[len("/static/"):])
        if url.path.startswith("/p/"):
            return self.serve_file(self.root, url.path[len("/p/"):])
        if url.path == "/api/project":
            pj = self.root / "project.json"
            if pj.exists():
                return self.send_json(json.loads(pj.read_text(encoding="utf-8")))
            return self.send_json({"frames": [{"file": f} for f in list_frames(self.root)]})
        if url.path == "/api/files":
            return self.send_json(list_frames(self.root))
        self.send_error(404)

    def do_PUT(self):
        if urlparse(self.path).path != "/api/project":
            return self.send_error(404)
        data = json.loads(self.body())
        if not isinstance(data, dict) or not isinstance(data.get("frames"), list):
            return self.send_json({"error": "bad project"}, 400)
        write_json_atomic(self.root / "project.json", data)
        self.send_json({"ok": True})

    def do_POST(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/api/upload":
                d = self.root / "frames"
                d.mkdir(parents=True, exist_ok=True)
                name = safe_name(q.get("name", "frame.png"))
                stem, ext = os.path.splitext(name)
                if ext.lower() not in IMAGE_EXT:
                    return self.send_json({"error": f"unsupported type: {name}"}, 400)
                p, n = d / name, 1
                while p.exists():  # never overwrite an existing source frame
                    p, n = d / f"{stem}_{n}{ext}", n + 1
                p.write_bytes(self.body())
                return self.send_json({"file": f"frames/{p.name}"})
            if url.path == "/api/export/frame":
                i = int(q["i"])
                d = self.root / "output" / "aligned"
                if i == 1 and d.exists():
                    shutil.rmtree(d)
                d.mkdir(parents=True, exist_ok=True)
                (d / f"frame_{i:04d}.png").write_bytes(self.body())
                return self.send_json({"ok": True})
            if url.path == "/api/export/encode":
                req = json.loads(self.body())
                outs = [encode(self.root, req["sequence"], f).relative_to(self.root).as_posix()
                        for f in req["formats"] if f in FORMATS]
                return self.send_json({"outputs": outs})
        except Exception as e:  # report to the UI instead of dropping the connection
            return self.send_json({"error": str(e)}, 500)
        self.send_error(404)


class Server(ThreadingHTTPServer):
    # Windows' SO_REUSEADDR lets two servers share one port and split the requests between them
    allow_reuse_address = os.name != "nt"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8765
    if "--port" in sys.argv:
        args.remove(str(port))
    root = Path(args[0] if args else "project").resolve()
    (root / "frames").mkdir(parents=True, exist_ok=True)
    Handler.root = root
    for port in range(port, port + 20):  # another editor already running? take the next free port
        try:
            srv = Server(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    else:
        sys.exit("No free port found")
    url = f"http://127.0.0.1:{port}/"
    print(f"Project: {root}\nEditor:  {url}")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    srv.serve_forever()


if __name__ == "__main__":
    main()
