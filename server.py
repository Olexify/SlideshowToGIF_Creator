"""Frame alignment workstation: local server.

Usage: python server.py [--port 8765] [--no-browser] [--data DIR]

Images are linked from wherever they are on disk; nothing is copied unless "Keep copies" is on.
The only exceptions are files that have no disk path the browser can tell us about (dropped files)
and files the app generates itself (split sprite sheets).

DATA (default: this folder):
  settings.json                 export folder, copy toggle, last project
  projects/<id>/project.json    name, canvas, fps, frames[{file,x,y,scale,rotation,duration}], ...
  projects/<id>/files/          copies (dropped / generated / "keep copies"); absent if none
  exports/                      used when the export folder is set to "App folder"
"""
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

STATIC = Path(__file__).parent / "static"
DATA = Path(__file__).parent
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/webp", ".webp")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
FORMATS = {
    "gif": ["-fps_mode", "vfr", "-vf", "split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse", "-loop", "0"],
    # video: constant 60 fps, per-frame holds become duplicated frames (cheap to encode)
    "mp4": ["-vf", "fps=60,pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16"],
    "webm": ["-vf", "fps=60", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "20"],
}
DEFAULT_SETTINGS = {"exportMode": "downloads", "exportCustom": "", "copyImports": False, "lastProject": "", "lastDir": ""}
LOCK = threading.Lock()      # settings / project-list writes
TK_LOCK = threading.Lock()   # one native dialog at a time
LINKED = {}                  # project id -> paths picked this session (allowed before the first autosave lands)


# ---------- helpers ----------
def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", str(s))]


def safe_name(name, fallback="frame.png"):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", os.path.basename(name)).strip(" .")
    return name or fallback


def unique(path):
    """path, or 'name (2).ext' style variant that doesn't exist yet: never overwrite user files."""
    p, n = Path(path), 2
    while p.exists():
        p = Path(path).with_name(f"{Path(path).stem} ({n}){Path(path).suffix}")
        n += 1
    return p


def write_json_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def settings():
    return {**DEFAULT_SETTINGS, **read_json(DATA / "settings.json", {})}


def save_settings(patch):
    with LOCK:
        s = {**settings(), **{k: v for k, v in patch.items() if k in DEFAULT_SETTINGS}}
        write_json_atomic(DATA / "settings.json", s)
        return s


def export_dir(s=None):
    s = s or settings()
    if s["exportMode"] == "custom" and s["exportCustom"]:
        return Path(s["exportCustom"])
    if s["exportMode"] == "app":
        return DATA / "exports"
    return Path.home() / "Downloads"


def pdir(pid):
    if not re.fullmatch(r"[a-z0-9]{6,32}", pid or ""):
        raise KeyError("bad project id")
    return DATA / "projects" / pid


def load_project(pid):
    p = pdir(pid) / "project.json"
    if not p.exists():
        raise KeyError("no such project")
    return read_json(p, {"frames": []})


def list_projects():
    out = []
    for d in (DATA / "projects").glob("*/project.json"):
        p = read_json(d, {})
        out.append({"id": d.parent.name, "name": p.get("name") or "Untitled", "frames": len(p.get("frames", [])),
                    "updated": d.stat().st_mtime})
    return sorted(out, key=lambda p: -p["updated"])


def create_project(name):
    pid = secrets.token_hex(5)
    write_json_atomic(pdir(pid) / "project.json", {"name": name or "Untitled", "frames": []})
    return pid


def resolve_image(pid, f):
    """Disk path for a frame entry: absolute = linked original, relative = copy inside the project folder.
    Only paths that belong to the project (or were picked this session) are served."""
    if Path(f).suffix.lower() not in IMAGE_EXT:
        raise KeyError("not an image")
    if os.path.isabs(f):
        allowed = {x.get("file") for x in load_project(pid).get("frames", [])} | LINKED.get(pid, set())
        if f not in allowed:
            raise KeyError("not part of this project")
        return Path(f)
    base = pdir(pid).resolve()
    p = (base / f).resolve()
    if base not in p.parents:
        raise KeyError("outside project")
    return p


def copy_into(pid, src_name, data=None, src_path=None):
    d = pdir(pid) / "files"
    d.mkdir(parents=True, exist_ok=True)
    dst = unique(d / safe_name(src_name))
    if src_path:
        shutil.copy2(src_path, dst)
    else:
        dst.write_bytes(data)
    return f"files/{dst.name}"


def native_pick(folder, initial):
    """Windows/macOS/Linux file dialog via tkinter (stdlib). Returns absolute paths, natural-sorted."""
    import tkinter
    from tkinter import filedialog
    with TK_LOCK:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        root.update()
        try:
            if folder:
                d = filedialog.askdirectory(parent=root, title="Add all images in a folder", initialdir=initial or None)
                files = [str(p) for p in Path(d).iterdir() if p.suffix.lower() in IMAGE_EXT] if d else []
            else:
                files = list(filedialog.askopenfilenames(parent=root, title="Add frames", initialdir=initial or None,
                                                         filetypes=[("Images", "*.png *.jpg *.jpeg *.webp")]))
        finally:
            root.destroy()
    return sorted((os.path.normpath(f) for f in files), key=lambda p: natural_key(Path(p).name))


def native_pick_dir(title, initial):
    import tkinter
    from tkinter import filedialog
    with TK_LOCK:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        root.update()
        try:
            d = filedialog.askdirectory(parent=root, title=title, initialdir=initial or None)
        finally:
            root.destroy()
    return os.path.normpath(d) if d else ""


def open_folder(path):
    if os.name == "nt":
        os.startfile(path)
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])


def encode(src, sequence, fmt, out):
    """Encode src/frame_0001.png… into out. sequence: [{"i": 1-based frame index, "duration": ms}]."""
    lines, secs = [], [max(float(s["duration"]), 10) / 1000 for s in sequence]
    for s, d in zip(sequence, secs):
        # framerate 1000 = 1 ms timebase; image2's default 25 fps would quantize durations to 40 ms
        lines += [f"file 'frame_{int(s['i']):04d}.png'", "option framerate 1000", f"duration {d:.4f}"]
    lines += lines[-3:-1]  # repeat last file so its duration is honoured
    (src / "list.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    # the muxers don't know the last frame's length on their own: cap it explicitly
    end = (["-frames:v", str(len(sequence)), "-final_delay", str(round(secs[-1] * 100))] if fmt == "gif"
           else ["-t", f"{sum(secs):.4f}"])
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
           "-i", str(src / "list.txt"), *FORMATS[fmt], *end, str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or f"ffmpeg failed ({fmt})")
    return out


def migrate_old_project():
    """v1 kept a single ./project folder with copies in frames/: turn it into a normal project."""
    old = DATA / "project"
    if not (old / "project.json").exists() or (DATA / "projects").exists():
        return
    pid = secrets.token_hex(5)
    shutil.move(str(old), str(pdir(pid)))
    d = pdir(pid)
    if (d / "frames").exists():
        (d / "frames").rename(d / "files")
    shutil.rmtree(d / "output", ignore_errors=True)
    p = read_json(d / "project.json", {"frames": []})
    p["name"] = p.get("name") or "My first project"
    for f in p.get("frames", []):
        if f.get("file", "").startswith("frames/"):
            f["file"] = "files/" + f["file"][len("frames/"):]
    write_json_atomic(d / "project.json", p)


# ---------- HTTP ----------
class Handler(SimpleHTTPRequestHandler):
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

    def jbody(self):
        return json.loads(self.body() or b"{}")

    def send_path(self, p):
        if not p.is_file():
            return self.send_error(404)
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(p)))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def serve_static(self, rel):
        base = STATIC.resolve()
        p = (base / unquote(rel)).resolve()
        return self.send_path(p) if base in p.parents else self.send_error(404)

    def trusted(self):
        # Only our own page may call the API: a localhost Host header (blocks DNS rebinding) and, for anything
        # that changes state, a custom header that other websites can't send without a CORS preflight we never allow.
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if host not in ("127.0.0.1", "localhost"):
            return False
        return self.command == "GET" or self.headers.get("X-Frame-Aligner") == "1"

    def handle_one(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        parts = [unquote(x) for x in url.path.strip("/").split("/")]
        m = self.command
        if m == "GET" and url.path in ("/", "/index.html"):
            return self.serve_static("index.html")
        if m == "GET" and url.path == "/favicon.ico":
            return self.serve_static("icon.ico")
        if m == "GET" and parts[0] == "static":
            return self.serve_static("/".join(parts[1:]))
        if parts[0] != "api":
            return self.send_error(404)
        if not self.trusted():
            return self.send_json({"error": "forbidden"}, 403)
        route = parts[1:]

        if route == ["settings"]:
            if m == "PUT":
                save_settings(self.jbody())
            s = settings()
            return self.send_json({**s, "exportPath": str(export_dir(s)),
                                   "downloads": str(Path.home() / "Downloads"), "appExports": str(DATA / "exports")})
        if route == ["settings", "pick-export-dir"] and m == "POST":
            d = native_pick_dir("Export folder", settings()["exportCustom"])
            if d:
                save_settings({"exportMode": "custom", "exportCustom": d})
            return self.send_json({"picked": d})
        if route == ["open-exports"] and m == "POST":
            d = export_dir()
            d.mkdir(parents=True, exist_ok=True)
            open_folder(d)
            return self.send_json({"ok": True})

        if route == ["projects"]:
            if m == "POST":
                pid = create_project(self.jbody().get("name", "").strip()[:80])
                save_settings({"lastProject": pid})
                return self.send_json({"id": pid})
            return self.send_json(list_projects())
        if route == ["projects", "delete-others"] and m == "POST":
            keep = self.jbody().get("keep")
            for p in list_projects():
                if p["id"] != keep:
                    shutil.rmtree(pdir(p["id"]), ignore_errors=True)
            return self.send_json({"ok": True})

        if len(route) >= 2 and route[0] == "p":
            pid, rest = route[1], route[2:]
            d = pdir(pid)
            if rest == [] and m == "GET":
                save_settings({"lastProject": pid})
                return self.send_json(load_project(pid))
            if rest == [] and m == "PUT":
                data = self.jbody()
                if not isinstance(data, dict) or not isinstance(data.get("frames"), list):
                    return self.send_json({"error": "bad project"}, 400)
                load_project(pid)  # must exist (deleted in another tab -> don't resurrect it)
                write_json_atomic(d / "project.json", data)
                return self.send_json({"ok": True})
            if rest == ["delete"] and m == "POST":
                shutil.rmtree(d, ignore_errors=True)  # only the project folder: linked originals are never touched
                return self.send_json({"ok": True})
            if rest == ["clear"] and m == "POST":
                p = load_project(pid)
                shutil.rmtree(d / "files", ignore_errors=True)
                write_json_atomic(d / "project.json", {"name": p.get("name", "Untitled"), "frames": [],
                                                       "fps": p.get("fps", 12), "loop": p.get("loop", "loop"),
                                                       "background": p.get("background", "clamp")})
                return self.send_json({"ok": True})
            if rest == ["img"] and m == "GET":
                return self.send_path(resolve_image(pid, q.get("f", "")))
            if rest == ["upload"] and m == "POST":  # dropped/generated files: no disk path known -> copy
                name = safe_name(q.get("name", "frame.png"))
                if Path(name).suffix.lower() not in IMAGE_EXT:
                    return self.send_json({"error": f"unsupported type: {name}"}, 400)
                load_project(pid)
                return self.send_json({"file": copy_into(pid, name, data=self.body())})
            if rest == ["pick"] and m == "POST":
                load_project(pid)
                req, s = self.jbody(), settings()
                paths = native_pick(bool(req.get("folder")), s["lastDir"])
                if not paths:
                    return self.send_json({"files": []})
                save_settings({"lastDir": str(Path(paths[0]).parent)})
                if s["copyImports"]:
                    files = [copy_into(pid, Path(p).name, src_path=p) for p in paths]
                else:
                    LINKED.setdefault(pid, set()).update(paths)
                    files = paths
                return self.send_json({"files": files})
            if rest == ["export", "frame"] and m == "POST":
                i, r = int(q["i"]), d / "render"
                if i == 1:
                    shutil.rmtree(r, ignore_errors=True)
                r.mkdir(parents=True, exist_ok=True)
                (r / f"frame_{i:04d}.png").write_bytes(self.body())
                return self.send_json({"ok": True})
            if rest == ["export", "finish"] and m == "POST":
                req, r = self.jbody(), d / "render"
                out_dir = export_dir()
                out_dir.mkdir(parents=True, exist_ok=True)
                base = safe_name(load_project(pid).get("name") or "animation", "animation")
                outs = []
                try:
                    for f in req.get("formats", []):
                        if f in FORMATS:
                            outs.append(str(encode(r, req["sequence"], f, unique(out_dir / f"{base}.{f}"))))
                    if req.get("png"):
                        seq_dir = unique(out_dir / f"{base} frames")
                        seq_dir.mkdir(parents=True)
                        for p in sorted(r.glob("frame_*.png")):
                            shutil.copy2(p, seq_dir / p.name)
                        outs.append(str(seq_dir))
                finally:
                    shutil.rmtree(r, ignore_errors=True)  # renders are temporary
                return self.send_json({"outputs": outs, "dir": str(out_dir)})
        return self.send_error(404)

    def dispatch(self):
        try:
            self.handle_one()
        except KeyError as e:
            self.send_json({"error": str(e.args[0] if e.args else e)}, 404)
        except Exception as e:  # report to the UI instead of dropping the connection
            self.send_json({"error": str(e)}, 500)

    do_GET = do_PUT = do_POST = dispatch


class Server(ThreadingHTTPServer):
    # Windows' SO_REUSEADDR lets two servers share one port and split the requests between them
    allow_reuse_address = os.name != "nt"


def main():
    global DATA
    arg = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
    port = int(arg("--port", 8765))
    DATA = Path(arg("--data", DATA)).resolve()
    (DATA / "projects").parent.mkdir(parents=True, exist_ok=True)
    migrate_old_project()
    (DATA / "projects").mkdir(exist_ok=True)
    for port in range(port, port + 20):  # another editor already running? take the next free port
        try:
            srv = Server(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    else:
        sys.exit("No free port found")
    url = f"http://127.0.0.1:{port}/"
    print(f"Data:   {DATA}\nEditor: {url}", flush=True)
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    srv.serve_forever()


if __name__ == "__main__":
    main()
