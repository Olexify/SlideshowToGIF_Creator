import { IDENTITY, drawFrame, renderExport } from "./render.js";

const $ = (id) => document.getElementById(id);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const urlOf = (file) => "/p/" + file.split("/").map(encodeURIComponent).join("/");
const stem = (file) => file.split("/").pop().replace(/\.[^.]+$/, "");

// ---------- state ----------
let project = { frames: [] };
let cur = 0;
let playing = false, playTimer = 0, pingDir = 1;
let blinkOn = false, blinkPhase = false, blinkTimer = 0;
let clipboard = null;
let mouse = null; // last pointer position in screen (CSS) px, for the crosshair
let split = 0.5;  // compare mode: divider position as a fraction of canvas width (left = current, right = reference)
// VIEWPORT = how the workspace is looked at (editor only, never saved into frames or exported).
const viewport = { zoom: 1, panX: 0, panY: 0 };

const view = $("view");
const vctx = view.getContext("2d");
const comp = document.createElement("canvas"); // project-canvas-sized composite of current frame + reference
const cctx = comp.getContext("2d");
const images = new Map();

function normalize(p) {
  p.fps = +p.fps || 12;
  p.loop = p.loop === "pingpong" ? "pingpong" : "loop";
  p.background = ["clamp", "black", "transparent"].includes(p.background) ? p.background : "clamp";
  p.markers = Array.isArray(p.markers) ? p.markers : [];
  p.frames = (p.frames || []).map((f) => ({
    file: f.file, x: +f.x || 0, y: +f.y || 0, scale: +f.scale || 1, rotation: +f.rotation || 0,
    duration: +f.duration || null,
  }));
  return p;
}

const frame = () => project.frames[cur];
const T = (f) => ({ x: f.x, y: f.y, scale: f.scale, rotation: f.rotation });
const duration = (f) => f.duration || 1000 / project.fps;
const isIdentity = (f) => f.x === 0 && f.y === 0 && f.scale === 1 && f.rotation === 0;

function img(file) {
  let im = images.get(file);
  if (!im) {
    im = new Image();
    im.onload = () => {
      if (!project.canvas) { project.canvas = { width: im.naturalWidth, height: im.naturalHeight }; syncCanvas(); fit(); save(); }
      render();
    };
    im.src = urlOf(file);
    images.set(file, im);
  }
  return im;
}

// ---------- status / toast ----------
function status(text, cls = "") { $("saveState").textContent = text; $("saveState").className = "pill " + cls; }
let toastTimer = 0;
function toast(text, err = false, ms = 2500) {
  const t = $("toast"); t.textContent = text; t.className = err ? "err" : ""; t.hidden = false;
  clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- save (debounced) ----------
let saveTimer = 0;
function save() {
  status("Unsaved…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}
async function flushSave(keepalive = false) {
  clearTimeout(saveTimer); saveTimer = 0;
  try {
    const r = await fetch("/api/project", { method: "PUT", body: JSON.stringify(project), keepalive });
    if (!r.ok) throw new Error(r.status);
    status("Saved", "ok");
  } catch (e) {
    status("Save failed, retrying…", "err");
    saveTimer = setTimeout(flushSave, 2000);
  }
}
addEventListener("pagehide", () => saveTimer && flushSave(true));

// ---------- undo / redo (snapshots of frames: transforms, order, durations) ----------
const undoStack = [], redoStack = [];
let lastKey = null, lastTime = 0;
function checkpoint(key = null) {
  const now = Date.now();
  if (key && key === lastKey && now - lastTime < 700) { lastTime = now; return; } // coalesce key-repeat / wheel
  undoStack.push(JSON.stringify(project.frames));
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
  lastKey = key; lastTime = now;
}
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(project.frames));
  const file = frame()?.file;
  project.frames = JSON.parse(from.pop());
  const i = project.frames.findIndex((f) => f.file === file);
  cur = i >= 0 ? i : Math.min(cur, project.frames.length - 1);
  lastKey = null;
  changed(true);
}

// Call after any edit. timeline=true when order/durations/frame list changed.
function changed(timeline = false) {
  if (timeline) buildTimeline(); else refreshTimeline();
  updatePanel();
  render();
  save();
}

// ---------- reference ----------
function refIndex() {
  const n = project.frames.length, sel = $("refFrame").value;
  if (n < 2) return -1;
  let i = sel === "prev" ? (cur - 1 + n) % n : sel === "next" ? (cur + 1) % n : sel === "first" ? 0
    : project.frames.findIndex((f) => f.file === sel);
  return i === cur ? -1 : i;
}

// ---------- rendering ----------
let rafPending = false;
function render() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; draw(); });
}

let checker, lastBadges = null;
function draw() {
  const dpr = devicePixelRatio || 1;
  const cw = view.clientWidth, ch = view.clientHeight;
  if (view.width !== Math.round(cw * dpr) || view.height !== Math.round(ch * dpr)) {
    view.width = Math.round(cw * dpr); view.height = Math.round(ch * dpr);
  }
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.clearRect(0, 0, view.width, view.height);
  $("empty").hidden = project.frames.length > 0;
  $("hints").hidden = !project.frames.length;
  const f = frame();
  if (f) img(f.file); // first load sets project.canvas from the image size
  if (!f || !project.canvas) return;

  // 1) composite in project-canvas space
  const bg = project.background;
  cctx.globalCompositeOperation = "source-over"; cctx.globalAlpha = 1;
  cctx.clearRect(0, 0, comp.width, comp.height);
  if (bg === "black") { cctx.fillStyle = "#000"; cctx.fillRect(0, 0, comp.width, comp.height); }
  const ri = playing ? -1 : refIndex();
  const rf = ri >= 0 ? project.frames[ri] : null;
  const mode = $("refMode").value;
  if (blinkOn && blinkPhase && rf && !playing) {
    drawFrame(cctx, img(rf.file), T(rf), bg);
  } else {
    drawFrame(cctx, img(f.file), T(f), bg);
    if (rf && mode === "onion") {
      cctx.globalAlpha = $("refOpacity").value / 100;
      drawFrame(cctx, img(rf.file), T(rf), bg);
    } else if (rf && mode === "diff") {
      cctx.globalCompositeOperation = "difference";
      drawFrame(cctx, img(rf.file), T(rf), bg);
    } else if (rf && mode === "split") {
      const x = Math.round(split * comp.width);
      cctx.save();
      cctx.beginPath(); cctx.rect(x, 0, comp.width - x, comp.height); cctx.clip();
      cctx.clearRect(x, 0, comp.width - x, comp.height);
      if (bg === "black") { cctx.fillStyle = "#000"; cctx.fillRect(x, 0, comp.width - x, comp.height); }
      drawFrame(cctx, img(rf.file), T(rf), bg);
      cctx.restore();
    }
    cctx.globalCompositeOperation = "source-over"; cctx.globalAlpha = 1;
  }

  // 2) composite -> screen through the viewport transform
  const { zoom, panX, panY } = viewport;
  const W = comp.width, H = comp.height;
  vctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY);
  vctx.save();
  vctx.shadowColor = "rgba(0,0,0,.6)"; vctx.shadowBlur = 30 * dpr; vctx.shadowOffsetY = 6 * dpr;
  vctx.fillStyle = "#000"; vctx.fillRect(0, 0, W, H);
  vctx.restore();
  if (bg === "transparent") {
    checker ??= vctx.createPattern(makeChecker(), "repeat");
    vctx.fillStyle = checker; vctx.fillRect(0, 0, W, H);
  }
  vctx.imageSmoothingEnabled = zoom < 2; // show real pixels when zoomed in
  vctx.drawImage(comp, 0, 0);

  // 3) overlays in screen space (never part of the frames)
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = (x) => x * zoom + panX, sy = (y) => y * zoom + panY;
  vctx.lineWidth = 1;
  vctx.strokeStyle = "#555"; vctx.strokeRect(sx(0) - 0.5, sy(0) - 0.5, W * zoom + 1, H * zoom + 1);
  const line = (x1, y1, x2, y2) => { vctx.beginPath(); vctx.moveTo(x1, y1); vctx.lineTo(x2, y2); vctx.stroke(); };
  vctx.strokeStyle = "rgba(78,161,255,.8)";
  if ($("gCenter").checked) { line(sx(W / 2), sy(0), sx(W / 2), sy(H)); line(sx(0), sy(H / 2), sx(W), sy(H / 2)); }
  if ($("gThirds").checked) for (const k of [1, 2]) {
    line(sx((W * k) / 3), sy(0), sx((W * k) / 3), sy(H)); line(sx(0), sy((H * k) / 3), sx(W), sy((H * k) / 3));
  }
  if ($("gCross").checked && mouse) {
    vctx.strokeStyle = "rgba(255,255,255,.6)";
    line(mouse.x, 0, mouse.x, ch); line(0, mouse.y, cw, mouse.y);
  }
  if ($("gMarkers").checked) {
    vctx.font = "11px system-ui";
    project.markers.forEach((m, i) => {
      const x = sx(m.x), y = sy(m.y);
      vctx.strokeStyle = "#000"; vctx.lineWidth = 3; marker(x, y);
      vctx.strokeStyle = "#ffb347"; vctx.lineWidth = 1; marker(x, y);
      vctx.fillStyle = "#ffb347"; vctx.fillText(i + 1, x + 9, y - 6);
    });
  }
  if (rf && mode === "split" && !(blinkOn && blinkPhase)) drawSplit(sx(split * W), sy(0), sy(H), ri);
  $("zoomVal").textContent = Math.round(zoom * 100) + "%";
  const badges = playing ? `<span class="badge">PLAYING</span>`
    : (rf ? (blinkOn ? `<span class="badge ref">BLINK ${$("blinkMs").value}ms</span>` : "")
      + (mode === "onion" ? `<span class="badge ref">ONION ${$("refOpacity").value}% · #${ri + 1}</span>`
        : mode === "diff" ? `<span class="badge ref">DIFFERENCE · #${ri + 1}</span>`
        : mode === "split" ? `<span class="badge ref">SPLIT · #${ri + 1}</span>` : "") : "");
  if (badges !== lastBadges) $("hudBadges").innerHTML = lastBadges = badges; // built from numbers only
}
function drawSplit(x, top, bottom, ri) {
  const mid = (top + bottom) / 2;
  vctx.save();
  vctx.shadowColor = "rgba(0,0,0,.7)"; vctx.shadowBlur = 6;
  vctx.fillStyle = "#fff"; vctx.fillRect(x - 1, top, 2, bottom - top);
  vctx.beginPath(); vctx.arc(x, mid, 14, 0, Math.PI * 2); vctx.fill();
  vctx.shadowBlur = 0;
  vctx.fillStyle = "#111";
  vctx.beginPath(); vctx.moveTo(x - 9, mid); vctx.lineTo(x - 3, mid - 5); vctx.lineTo(x - 3, mid + 5); vctx.fill();
  vctx.beginPath(); vctx.moveTo(x + 9, mid); vctx.lineTo(x + 3, mid - 5); vctx.lineTo(x + 3, mid + 5); vctx.fill();
  // labels
  vctx.font = "600 11px Segoe UI, system-ui, sans-serif"; vctx.textBaseline = "middle";
  const pill = (text, px, color, right) => {
    const w = vctx.measureText(text).width + 16, y = top + 18;
    const left = right ? px + 8 : px - 8 - w;
    vctx.fillStyle = "rgba(17,18,21,.85)"; vctx.beginPath(); vctx.roundRect(left, y - 10, w, 20, 10); vctx.fill();
    vctx.fillStyle = color; vctx.fillText(text, left + 8, y + 1);
  };
  pill("CURRENT", x, "#5b9cff", false);
  pill(`REF #${ri + 1}`, x, "#ffb44a", true);
  vctx.restore();
}
const nearSplit = (m) => {
  if (!m || $("refMode").value !== "split" || refIndex() < 0 || playing) return false;
  const x = split * comp.width * viewport.zoom + viewport.panX;
  return Math.abs(m.x - x) < 10 && m.y >= viewport.panY && m.y <= viewport.panY + comp.height * viewport.zoom;
};
function marker(x, y) {
  vctx.beginPath(); vctx.arc(x, y, 6, 0, Math.PI * 2);
  vctx.moveTo(x - 11, y); vctx.lineTo(x + 11, y); vctx.moveTo(x, y - 11); vctx.lineTo(x, y + 11); vctx.stroke();
}
function makeChecker() {
  const c = document.createElement("canvas"); c.width = c.height = 16;
  const g = c.getContext("2d"); g.fillStyle = "#444"; g.fillRect(0, 0, 16, 16);
  g.fillStyle = "#666"; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
  return c;
}

// ---------- viewport ----------
function syncCanvas() {
  comp.width = project.canvas.width; comp.height = project.canvas.height;
  $("cw").value = comp.width; $("ch").value = comp.height;
}
function fit() {
  if (!project.canvas) return;
  // leave room for the HUD (top) and hint/zoom bars (bottom)
  const z = Math.min((view.clientWidth - 48) / comp.width, (view.clientHeight - 104) / comp.height);
  setZoom(z, view.clientWidth / 2, view.clientHeight / 2, true);
}
function setZoom(z, cx, cy, center = false) {
  z = Math.min(Math.max(z, 0.05), 32);
  if (center) {
    viewport.panX = cx - (comp.width * z) / 2; viewport.panY = cy - (comp.height * z) / 2;
  } else { // keep the canvas point under (cx, cy) fixed
    viewport.panX = cx - ((cx - viewport.panX) / viewport.zoom) * z;
    viewport.panY = cy - ((cy - viewport.panY) / viewport.zoom) * z;
  }
  viewport.zoom = z;
  render();
}
const toCanvas = (x, y) => ({ x: (x - viewport.panX) / viewport.zoom, y: (y - viewport.panY) / viewport.zoom });
addEventListener("resize", render);

// ---------- frame transform edits ----------
function setT(patch, key) {
  const f = frame(); if (!f) return;
  checkpoint(key);
  if ("x" in patch) f.x = round(patch.x, 2);
  if ("y" in patch) f.y = round(patch.y, 2);
  if ("scale" in patch) f.scale = round(Math.min(Math.max(patch.scale, 0.01), 100), 4); // 0.01% precision
  if ("rotation" in patch) f.rotation = round(patch.rotation, 4);
  changed();
}
const nudge = (dx, dy) => setT({ x: frame().x + dx, y: frame().y + dy }, "nudge");
const rotate = (d) => setT({ rotation: frame().rotation + d }, "rotate");

// ---------- pointer on canvas ----------
let drag = null;
view.addEventListener("pointerdown", (e) => {
  if (!frame()) return;
  view.setPointerCapture(e.pointerId);
  const rect = view.getBoundingClientRect();
  mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  if (e.button === 1 || e.button === 2) {
    drag = { pan: true, sx: e.clientX, sy: e.clientY, px: viewport.panX, py: viewport.panY };
  } else if (e.button === 0 && nearSplit(mouse)) {
    drag = { split: true };
  } else if (e.button === 0 && $("markerTool").checked) {
    const r = view.getBoundingClientRect();
    const p = toCanvas(e.clientX - r.left, e.clientY - r.top);
    project.markers.push({ x: round(p.x, 1), y: round(p.y, 1) });
    $("gMarkers").checked = true;
    render(); save();
  } else if (e.button === 0) {
    if (playing) togglePlay();
    checkpoint();
    drag = { sx: e.clientX, sy: e.clientY, fx: frame().x, fy: frame().y };
    view.classList.add("dragging");
  }
});
view.addEventListener("pointermove", (e) => {
  const r = view.getBoundingClientRect();
  mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (!drag) { view.classList.toggle("splitting", nearSplit(mouse)); if ($("gCross").checked) render(); return; }
  if (drag.split) {
    split = Math.min(Math.max(toCanvas(mouse.x, mouse.y).x / comp.width, 0), 1); render();
  } else if (drag.pan) {
    viewport.panX = drag.px + e.clientX - drag.sx; viewport.panY = drag.py + e.clientY - drag.sy; render();
  } else {
    const f = frame();
    f.x = round(drag.fx + (e.clientX - drag.sx) / viewport.zoom, 2);
    f.y = round(drag.fy + (e.clientY - drag.sy) / viewport.zoom, 2);
    updatePanel(); render(); // save + timeline on release, keeps dragging cheap
  }
});
const endDrag = () => {
  if (drag && !drag.pan && !drag.split) { refreshTimeline(); save(); }
  drag = null; view.classList.remove("dragging");
};
view.addEventListener("pointerup", endDrag);
view.addEventListener("pointercancel", endDrag);
view.addEventListener("pointerleave", () => { mouse = null; if ($("gCross").checked) render(); });
view.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (drag?.pan && (Math.abs(e.clientX - drag.sx) > 3 || Math.abs(e.clientY - drag.sy) > 3)) return;
  const r = view.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const i = project.markers.findIndex((m) => Math.hypot(m.x * viewport.zoom + viewport.panX - x, m.y * viewport.zoom + viewport.panY - y) < 10);
  if (i >= 0) { project.markers.splice(i, 1); render(); save(); }
});
view.addEventListener("wheel", (e) => {
  e.preventDefault();
  const d = e.deltaY || e.deltaX; // Shift+wheel reports deltaX on some systems
  const r = view.getBoundingClientRect();
  if (e.ctrlKey) return setZoom(viewport.zoom * Math.exp(-d * 0.0015), e.clientX - r.left, e.clientY - r.top);
  if (!frame()) return;
  // FRAME scale (alignment): ~1% per notch, Shift ~0.1%
  setT({ scale: frame().scale * Math.exp(-d * (e.shiftKey ? 0.00001 : 0.0001)) }, "wheel");
}, { passive: false });
view.addEventListener("dblclick", fit);

// ---------- side panel ----------
function updatePanel() {
  const f = frame();
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  set("tx", f ? f.x : ""); set("ty", f ? f.y : "");
  set("ts", f ? round(f.scale * 100, 4) : ""); set("tr", f ? f.rotation : "");
  set("dur", f?.duration ?? "");
  $("dur").placeholder = `auto (${Math.round(1000 / project.fps)})`;
  $("frameLabel").textContent = f ? `${cur + 1} / ${project.frames.length}` : "–";
  $("hudName").textContent = f ? f.file.split("/").pop() : "";
  $("scrub").max = Math.max(0, project.frames.length - 1); $("scrub").value = cur;
  const changedVal = { tx: f && f.x !== 0, ty: f && f.y !== 0, ts: f && f.scale !== 1, tr: f && f.rotation !== 0 };
  for (const [id, on] of Object.entries(changedVal)) $(id).parentElement.classList.toggle("changed", !!on);
  fillRanges();
}
// filled slider tracks: --p = percentage of the range
function fillRanges() {
  document.querySelectorAll("input[type=range]").forEach((r) => {
    const p = ((r.value - r.min) / (r.max - r.min || 1)) * 100;
    r.style.setProperty("--p", p + "%");
  });
}
addEventListener("input", (e) => { if (e.target.type === "range") fillRanges(); });
const fieldMap = { tx: ["x", 1], ty: ["y", 1], ts: ["scale", 100], tr: ["rotation", 1] };
for (const [id, [key, mul]] of Object.entries(fieldMap)) {
  $(id).addEventListener("input", () => {
    const v = parseFloat($(id).value);
    if (Number.isFinite(v)) setT({ [key]: v / mul }, "field-" + id);
  });
}
$("dur").addEventListener("change", () => {
  if (!frame()) return;
  checkpoint(); frame().duration = Math.max(10, parseInt($("dur").value)) || null; changed(true);
});
// drag a label to scrub its value (Shift = x10)
document.querySelectorAll("label[data-scrub]").forEach((lab) => {
  const key = lab.dataset.scrub, step = +lab.dataset.step;
  lab.addEventListener("pointerdown", (e) => {
    if (!frame()) return;
    lab.setPointerCapture(e.pointerId);
    let lastX = e.clientX;
    checkpoint();
    const move = (ev) => {
      const d = (ev.clientX - lastX) * step * (ev.shiftKey ? 10 : 1); lastX = ev.clientX;
      const f = frame();
      setT({ [key]: key === "scale" ? f.scale + d / 100 : f[key] + d }, "scrub");
    };
    lab.addEventListener("pointermove", move);
    lab.addEventListener("pointerup", () => lab.removeEventListener("pointermove", move), { once: true });
  });
});
$("copyT").onclick = () => { if (frame()) clipboard = T(frame()); };
$("pasteT").onclick = () => clipboard && setT(clipboard);
$("resetT").onclick = () => setT(IDENTITY);
$("prevT").onclick = () => cur > 0 && setT(T(project.frames[cur - 1]));

// reference controls
for (const id of ["refMode", "refFrame"]) $(id).addEventListener("change", () => { refreshTimeline(); render(); });
$("refOpacity").addEventListener("input", () => { $("refOpacityVal").textContent = $("refOpacity").value + "%"; render(); });
function setBlink(on) {
  blinkOn = on; $("blink").checked = on; clearInterval(blinkTimer); blinkPhase = false;
  if (on) blinkTimer = setInterval(() => { blinkPhase = !blinkPhase; render(); }, +$("blinkMs").value);
  render();
}
$("blink").addEventListener("change", () => setBlink($("blink").checked));
$("blinkMs").addEventListener("input", () => { $("blinkMsVal").textContent = $("blinkMs").value + "ms"; if (blinkOn) setBlink(true); });

// playback controls
function syncFps() {
  $("fpsVal").textContent = project.fps;
  for (const b of $("fpsPresets").children) b.classList.toggle("on", +b.textContent === project.fps);
}
$("fps").addEventListener("input", () => { project.fps = +$("fps").value; syncFps(); updatePanel(); refreshTimeline(); save(); });
for (const v of [6, 8, 10, 12, 15, 24]) {
  const b = document.createElement("button"); b.textContent = v;
  b.onclick = () => { $("fps").value = v; $("fps").dispatchEvent(new Event("input")); };
  $("fpsPresets").append(b);
}
$("loop").addEventListener("change", () => { project.loop = $("loop").value; save(); });

// view controls
for (const id of ["gCenter", "gThirds", "gCross", "gMarkers"]) $(id).addEventListener("change", render);
$("markerTool").addEventListener("change", () => view.classList.toggle("marker", $("markerTool").checked));
$("clearMarkers").onclick = () => { project.markers = []; render(); save(); };
$("background").addEventListener("change", () => { project.background = $("background").value; render(); save(); });
$("fit").onclick = fit;
$("zoomIn").onclick = () => setZoom(viewport.zoom * 1.25, view.clientWidth / 2, view.clientHeight / 2);
$("zoomOut").onclick = () => setZoom(viewport.zoom / 1.25, view.clientWidth / 2, view.clientHeight / 2);
$("z100").onclick = () => setZoom(1, view.clientWidth / 2, view.clientHeight / 2, true);
for (const id of ["cw", "ch"]) $(id).addEventListener("change", () => {
  const w = parseInt($("cw").value), h = parseInt($("ch").value);
  if (w > 0 && h > 0) { project.canvas = { width: w, height: h }; syncCanvas(); fit(); save(); }
});

// <select data-seg> renders as a segmented button row; the hidden select stays the source of truth.
function syncSegs() {
  document.querySelectorAll(".seg").forEach((seg) =>
    [...seg.children].forEach((b) => b.classList.toggle("on", b.dataset.v === seg.sel.value)));
}
document.querySelectorAll("select[data-seg]").forEach((sel) => {
  const seg = document.createElement("div");
  seg.className = "seg"; seg.sel = sel;
  for (const o of sel.options) {
    const b = document.createElement("button");
    b.textContent = o.text; b.dataset.v = o.value;
    if (sel.id === "refMode") b.title = "Compare mode (O)";
    b.onclick = () => { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); };
    seg.append(b);
  }
  sel.hidden = true; sel.after(seg);
  sel.addEventListener("change", syncSegs);
});

// ---------- navigation & playback ----------
function go(i) {
  const n = project.frames.length; if (!n) return;
  cur = ((i % n) + n) % n;
  updatePanel(); refreshTimeline(); render();
  if (playing) return;
  // preload neighbours so stepping is instant
  for (const j of [cur - 1, cur + 1]) if (project.frames[(j + n) % n]) img(project.frames[(j + n) % n].file);
}
function nextIndex() {
  const n = project.frames.length;
  if (project.loop !== "pingpong" || n < 2) return cur + 1;
  if (cur + pingDir >= n || cur + pingDir < 0) pingDir = -pingDir;
  return cur + pingDir;
}
function togglePlay() {
  playing = !playing;
  $("play").querySelector("use").setAttribute("href", playing ? "#i-pause" : "#i-play");
  clearTimeout(playTimer);
  if (playing) {
    project.frames.forEach((f) => img(f.file));
    pingDir = 1;
    const tick = () => { go(nextIndex()); playTimer = setTimeout(tick, duration(frame())); };
    playTimer = setTimeout(tick, duration(frame()));
  }
  render();
}
$("play").onclick = togglePlay;
$("prev").onclick = () => go(cur - 1);
$("next").onclick = () => go(cur + 1);
$("first").onclick = () => go(0);
$("last").onclick = () => go(project.frames.length - 1);
$("scrub").addEventListener("input", () => go(+$("scrub").value));
$("undo").onclick = () => restore(undoStack, redoStack);
$("redo").onclick = () => restore(redoStack, undoStack);
$("help").onclick = () => $("helpDlg").showModal();

// ---------- timeline ----------
let dragFrom = -1;
const isFileDrag = (e) => e.dataTransfer?.types.includes("Files");
function moveFrame(from, to) {
  checkpoint();
  const curFile = frame().file;
  const [moved] = project.frames.splice(from, 1);
  project.frames.splice(to, 0, moved);
  cur = project.frames.findIndex((x) => x.file === curFile);
  changed(true);
}
function buildTimeline() {
  const box = $("thumbs"); box.textContent = "";
  project.frames.forEach((f, i) => {
    const el = document.createElement("div");
    el.className = "thumb"; el.draggable = true;
    el.innerHTML = `<div class="pic"><img loading="lazy"><span class="no"></span><span class="reftag">REF</span><span class="dirty" title="Aligned (has a transform)"></span></div>
      <div class="name"></div>
      <div class="meta"><input type="number" min="10" step="1" title="Hold duration in ms (empty = from FPS)"><span>ms</span></div>
      <button class="del" title="Remove from project (file is kept)">×</button>`;
    el.querySelector("img").src = urlOf(f.file);
    el.querySelector(".no").textContent = i + 1;
    el.querySelector(".name").textContent = stem(f.file);
    el.title = f.file;
    const inp = el.querySelector("input");
    inp.value = f.duration ?? "";
    inp.onclick = (e) => e.stopPropagation();
    inp.onchange = () => { checkpoint(); f.duration = Math.max(10, parseInt(inp.value)) || null; changed(true); };
    el.querySelector(".del").onclick = (e) => {
      e.stopPropagation(); checkpoint();
      project.frames.splice(i, 1); if (cur >= project.frames.length) cur = Math.max(0, project.frames.length - 1);
      changed(true);
    };
    el.onclick = () => { if (playing) togglePlay(); go(i); };
    el.ondragstart = (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; el.classList.add("dragging"); };
    el.ondragend = () => { dragFrom = -1; el.classList.remove("dragging"); };
    el.ondragover = (e) => {
      const files = isFileDrag(e);
      if (dragFrom < 0 && !files) return;
      e.preventDefault(); e.stopPropagation();
      el.classList.add("over"); el.classList.toggle("dropfiles", files);
    };
    el.ondragleave = () => el.classList.remove("over", "dropfiles");
    el.ondrop = (e) => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove("over", "dropfiles"); hideDrop();
      if (isFileDrag(e)) return addFiles(e.dataTransfer.files, i); // insert before this frame
      if (dragFrom >= 0 && dragFrom !== i) moveFrame(dragFrom, i);
      dragFrom = -1;
    };
    box.append(el);
  });
  // "+" tile: click to browse, drop files to append, drop a frame to move it to the end
  const add = document.createElement("label");
  add.className = "addtile";
  add.innerHTML = `<svg><use href="#i-plus"/></svg>Add frames<input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden class="fileInput2">`;
  add.ondragover = (e) => { if (dragFrom < 0 && !isFileDrag(e)) return; e.preventDefault(); e.stopPropagation(); add.classList.add("dropfiles"); };
  add.ondragleave = () => add.classList.remove("dropfiles");
  add.ondrop = (e) => {
    e.preventDefault(); e.stopPropagation(); add.classList.remove("dropfiles"); hideDrop();
    if (isFileDrag(e)) return addFiles(e.dataTransfer.files, project.frames.length);
    if (dragFrom >= 0) moveFrame(dragFrom, project.frames.length - 1);
    dragFrom = -1;
  };
  box.append(add);
  // reference frame list
  const sel = $("refFrame"), keep = sel.value || "prev";
  sel.innerHTML = `<option value="prev">Previous frame</option><option value="next">Next frame</option><option value="first">Frame 1</option>`;
  project.frames.forEach((f, i) => sel.add(new Option(`#${i + 1}  ${stem(f.file)}`, f.file)));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "prev";
  refreshTimeline();
}
function refreshTimeline() {
  const ri = refIndex(), auto = Math.round(1000 / project.fps);
  $("thumbs").querySelectorAll(".thumb").forEach((el, i) => {
    el.classList.toggle("cur", i === cur);
    el.classList.toggle("ref", i === ri && $("refMode").value !== "off");
    el.querySelector(".dirty").hidden = isIdentity(project.frames[i]);
    el.querySelector("input").placeholder = auto;
  });
  $("thumbs").children[cur]?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ---------- adding frames ----------
// Without a position, new files go before the first frame whose name sorts after them,
// so "frame_001_5" lands between 001 and 002.
const byName = (a, b) => stem(a).localeCompare(stem(b), undefined, { numeric: true });
function insertFrame(file, at = null) {
  const f = normalize({ frames: [{ file }] }).frames[0];
  let i = at ?? project.frames.findIndex((x) => byName(x.file, file) > 0);
  if (i < 0) i = project.frames.length;
  project.frames.splice(i, 0, f);
  if (i <= cur && project.frames.length > 1) cur++;
}
async function addFiles(files, at = null) {
  const all = [...files];
  files = all.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) return toast(all.length ? "Only PNG, JPG and WebP images can be added" : "Nothing to add", true);
  checkpoint();
  const wasEmpty = !project.frames.length;
  let added = 0;
  for (const [n, file] of files.entries()) {
    toast(`Adding ${n + 1} / ${files.length}: ${file.name}`, false, 0);
    try {
      const r = await fetch("/api/upload?name=" + encodeURIComponent(file.name), { method: "POST", body: file });
      const j = await r.json();
      if (!j.file) throw new Error(j.error);
      insertFrame(j.file, at === null ? null : at++);
      added++;
    } catch (e) { toast(`${file.name}: ${e.message}`, true, 5000); }
  }
  if (wasEmpty) cur = 0;
  changed(true);
  if (added) toast(`Added ${added} frame${added > 1 ? "s" : ""}`);
}
document.addEventListener("change", (e) => {
  if (e.target.matches("#fileInput, .fileInput2")) { addFiles(e.target.files); e.target.value = ""; }
});
$("rescan").onclick = async () => {
  const files = await (await fetch("/api/files")).json();
  const have = new Set(project.frames.map((f) => f.file));
  const add = files.filter((f) => !have.has(f));
  if (!add.length) return toast("No new images in the frames folder");
  checkpoint();
  add.forEach((f) => insertFrame(f));
  changed(true);
  toast(`Added ${add.length} frame${add.length > 1 ? "s" : ""} from folder`);
};
// Drop anywhere else in the window: add in filename order.
let dropDepth = 0;
function hideDrop() { dropDepth = 0; $("drop").hidden = true; }
addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  dropDepth++; $("drop").hidden = false;
  const n = e.dataTransfer.items.length;
  $("dropHint").textContent = (n ? `${n} file${n > 1 ? "s" : ""} · ` : "") + "or drop on a thumbnail to insert there";
});
addEventListener("dragleave", (e) => { if (isFileDrag(e) && --dropDepth <= 0) hideDrop(); });
addEventListener("dragover", (e) => { if (isFileDrag(e)) e.preventDefault(); });
addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); hideDrop();
  addFiles(e.dataTransfer.files);
});

// ---------- export ----------
function exportSequence() {
  const n = project.frames.length;
  const order = [...Array(n).keys()];
  if (project.loop === "pingpong") for (let i = n - 2; i > 0; i--) order.push(i);
  return order.map((i) => ({ i: i + 1, duration: duration(project.frames[i]) }));
}
async function doExport(formats) {
  if (!project.frames.length || !project.canvas) return;
  if (playing) togglePlay();
  const state = $("exportState");
  const btns = [$("export"), $("exportPng")];
  btns.forEach((b) => (b.disabled = true));
  try {
    await flushSave();
    const c = document.createElement("canvas");
    c.width = project.canvas.width; c.height = project.canvas.height;
    const g = c.getContext("2d");
    for (const [i, f] of project.frames.entries()) {
      state.textContent = `Rendering frame ${i + 1}/${project.frames.length}…`;
      const im = img(f.file);
      await im.decode();
      renderExport(g, im, T(f), project.background);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      const r = await fetch(`/api/export/frame?i=${i + 1}`, { method: "POST", body: blob });
      if (!r.ok) throw new Error((await r.json()).error);
    }
    let outs = ["output/aligned/"];
    if (formats.length) {
      state.textContent = `Encoding ${formats.join(", ")}…`;
      const r = await fetch("/api/export/encode", { method: "POST", body: JSON.stringify({ formats, sequence: exportSequence() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      outs = outs.concat(j.outputs);
    }
    state.textContent = "Done: " + outs.join(", ");
  } catch (e) {
    state.textContent = "Export failed: " + e.message;
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}
$("export").onclick = () => doExport([["exGif", "gif"], ["exMp4", "mp4"], ["exWebm", "webm"]].filter(([id]) => $(id).checked).map(([, f]) => f));
$("exportPng").onclick = () => doExport([]);

// ---------- keyboard ----------
// Click/change on buttons, checkboxes, selects and sliders shouldn't keep focus, or Space/arrows would hit them.
addEventListener("pointerup", () => { const a = document.activeElement; if (a?.matches("button, input[type=checkbox], input[type=range]")) a.blur(); });
addEventListener("change", (e) => { if (e.target.matches("select, input[type=checkbox], input[type=range]")) e.target.blur(); });
addEventListener("keydown", (e) => {
  const t = e.target;
  if (t.matches("input[type=number], input[type=text], textarea")) { if (e.key === "Enter" || e.key === "Escape") t.blur(); return; }
  if ($("helpDlg").open) return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey, step = e.shiftKey ? 10 : 1;
  const has = !!frame();
  let handled = true;
  if (ctrl && k.toLowerCase() === "z") restore(...(e.shiftKey ? [redoStack, undoStack] : [undoStack, redoStack]));
  else if (ctrl && k.toLowerCase() === "y") restore(redoStack, undoStack);
  else if (ctrl && k.toLowerCase() === "c") $("copyT").click();
  else if (ctrl && k.toLowerCase() === "v") $("pasteT").click();
  else if (ctrl) handled = false;
  else if (k === "ArrowLeft" && has) nudge(-step, 0);
  else if (k === "ArrowRight" && has) nudge(step, 0);
  else if (k === "ArrowUp" && has) nudge(0, -step);
  else if (k === "ArrowDown" && has) nudge(0, step);
  else if (k === " ") togglePlay();
  else if (k === "a" || k === "A" || k === "PageUp") go(cur - 1);
  else if (k === "d" || k === "D" || k === "PageDown") go(cur + 1);
  else if (k === "Home") go(0);
  else if (k === "End") go(project.frames.length - 1);
  else if ((k === "q" || k === "Q") && has) rotate(-0.1 * step);
  else if ((k === "e" || k === "E") && has) rotate(0.1 * step);
  else if (k === "b" || k === "B") setBlink(!blinkOn);
  else if (k === "o" || k === "O") {
    const s = $("refMode"); s.selectedIndex = (s.selectedIndex + 1) % s.options.length; s.dispatchEvent(new Event("change"));
  } else if (k === "m" || k === "M") { $("markerTool").checked = !$("markerTool").checked; $("markerTool").dispatchEvent(new Event("change")); }
  else if (k === "f" || k === "F") fit();
  else if (k === "1") setZoom(1, view.clientWidth / 2, view.clientHeight / 2, true);
  else handled = false;
  if (handled) e.preventDefault();
});

// ---------- tooltips: title="Label (Key)" renders as a styled tip with a key cap ----------
const tip = $("tip");
let tipTimer = 0;
document.addEventListener("pointerover", (e) => {
  const el = e.target.closest("[title], [data-tip]");
  if (!el || el.closest("#thumbs")) return;
  if (el.title) { el.dataset.tip = el.title; el.removeAttribute("title"); }
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    const [, label, key] = el.dataset.tip.match(/^(.*?)(?:\s*\(([^)]+)\))?$/);
    tip.textContent = label;
    if (key) for (const k of key.split(" / ")) { const kb = document.createElement("kbd"); kb.textContent = k; tip.append(kb); }
    tip.hidden = false;
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const below = r.bottom + t.height + 10 < innerHeight;
    tip.style.left = Math.min(Math.max(r.left + r.width / 2 - t.width / 2, 6), innerWidth - t.width - 6) + "px";
    tip.style.top = (below ? r.bottom + 8 : r.top - t.height - 8) + "px";
  }, 400);
});
document.addEventListener("pointerout", (e) => {
  if (e.target.closest("[data-tip]")) { clearTimeout(tipTimer); tip.hidden = true; }
});
addEventListener("pointerdown", () => { clearTimeout(tipTimer); tip.hidden = true; });

// ---------- load ----------
(async () => {
  project = normalize(await (await fetch("/api/project")).json());
  $("fps").value = project.fps; $("fpsVal").textContent = project.fps;
  $("loop").value = project.loop; $("background").value = project.background;
  buildTimeline(); updatePanel(); go(0);
  if (project.canvas) { syncCanvas(); fit(); } // after the timeline exists, so the stage has its final size
  syncFps(); syncSegs();
  status("Loaded", "ok");
})();
