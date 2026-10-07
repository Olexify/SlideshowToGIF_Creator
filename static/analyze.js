// Automatic alignment and frame-quality analysis.
// Everything works on small grayscale renders of frames *with their transforms applied*, using the same
// transform math as render.js: image centred on a W×H canvas, shifted by x/y, rotated and scaled around its centre.

const CAP = 0.15; // per-pixel difference cap: moving parts of the drawing shouldn't dominate the match
export const LEVELS = [96, 224, 448]; // coarse → fine sample widths

const canvases = new Map();
function surface(w, h) {
  const key = w + "x" + h;
  let c = canvases.get(key);
  if (!c) {
    c = document.createElement("canvas"); c.width = w; c.height = h;
    c.g = c.getContext("2d", { willReadFrequently: true });
    canvases.set(key, c);
  }
  return c;
}

// Grayscale render of one frame at `size` px wide. m marks pixels the image actually covers.
// Brightness and contrast are normalised over the covered pixels, so exposure/colour drift between
// AI generations doesn't read as misalignment.
export function sample(img, t, W, H, size) {
  const w = size, h = Math.max(1, Math.round((size * H) / W)), k = w / W;
  const c = surface(w, h), g = c.g;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  g.setTransform(k, 0, 0, k, 0, 0);
  g.translate(W / 2 + t.x, H / 2 + t.y);
  g.rotate((t.rotation * Math.PI) / 180);
  g.scale(t.scale, t.scale);
  g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  const d = g.getImageData(0, 0, w, h).data;
  const n = w * h, gray = new Float32Array(n), m = new Uint8Array(n);
  let sum = 0, sq = 0, cnt = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255;
    gray[i] = v;
    if (d[j + 3] > 250) { m[i] = 1; sum += v; sq += v * v; cnt++; }
  }
  if (cnt) {
    const mean = sum / cnt, sd = Math.sqrt(Math.max(sq / cnt - mean * mean, 1e-6));
    const f = 0.18 / sd;
    for (let i = 0; i < n; i++) gray[i] = 0.5 + (gray[i] - mean) * f;
  }
  return { gray, m, n, w, h };
}

// Mean capped difference over pixels both frames cover; uncovered area is penalised so the search
// can't "win" by shrinking or sliding a frame off the canvas.
export function diff(a, b) {
  let s = 0, c = 0;
  for (let i = 0; i < a.n; i++) {
    if (a.m[i] & b.m[i]) { const d = Math.abs(a.gray[i] - b.gray[i]); s += d < CAP ? d : CAP; c++; }
  }
  if (!c) return CAP;
  const coverage = c / a.n;
  return s / c + CAP * Math.max(0, 0.85 - coverage);
}

// A reference made from one frame: target(size) -> sample
export const frameTarget = (img, t, W, H) => {
  const cache = new Map();
  return (size) => cache.get(size) ?? cache.set(size, sample(img, t, W, H, size)).get(size);
};

// A reference made from ALL frames: the per-pixel median of the aligned frames. Moving parts and one-off
// glitches get voted out, leaving the stable scene, so no single frame's flaws become everyone's target.
export function medianTarget(frames, W, H, levels = LEVELS) {
  const cache = new Map();
  for (const size of levels) {
    const ss = frames.map(({ img, t }) => sample(img, t, W, H, size));
    cache.set(size, { ...medianOfSamples(ss), n: ss[0].n });
  }
  return (size) => cache.get(size);
}

// Pattern search (coordinate descent with shrinking steps), coarse to fine.
// Returns the transform for `img` that best matches target(size).
export async function align(target, img, start, W, H,
  { scale = true, rotation = true, levels = LEVELS, shouldStop = () => false } = {}) {
  let t = { ...start };
  for (const [li, size] of levels.entries()) {
    const ref = target(size);
    const px = W / size; // one sample pixel in canvas px
    const cost = (c) => diff(ref, sample(img, c, W, H, size));
    let best = cost(t);
    // first level searches wide; finer levels only polish what the previous level found
    const steps = li === 0 ? { x: 4 * px, y: 4 * px, scale: 0.02, rotation: 1 }
      : { x: px, y: px, scale: 0.02 / 4 ** li, rotation: 1 / 4 ** li };
    const min = { x: 0.25 * px, y: 0.25 * px, scale: 0.0002, rotation: 0.01 };
    const keys = ["x", "y", ...(scale ? ["scale"] : []), ...(rotation ? ["rotation"] : [])];
    for (let evals = 0; evals < 400 && keys.some((k) => steps[k] >= min[k]); ) {
      let moved = false;
      for (const k of keys) {
        if (steps[k] < min[k]) continue;
        for (const dir of [1, -1]) {
          const c = { ...t, [k]: t[k] + dir * steps[k] };
          if (c.scale < 0.5 || c.scale > 2 || Math.abs(c.rotation) > 20) continue;
          const v = cost(c); evals++;
          if (v < best - 1e-7) { best = v; t = c; moved = true; break; }
        }
      }
      if (!moved) for (const k of keys) steps[k] /= 2;
      if (evals % 30 === 0) { await new Promise((r) => setTimeout(r)); if (shouldStop()) return t; } // keep the UI alive
    }
  }
  return {
    x: Math.round(t.x * 100) / 100, y: Math.round(t.y * 100) / 100,
    scale: Math.round(t.scale * 10000) / 10000, rotation: Math.round(t.rotation * 10000) / 10000,
  };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

// Quality of an aligned sequence.
//  score[i]  : how much frame i stands out (≈1 normal, ≫1 suspicious)
//  seam      : last → first step relative to a normal step (loop smoothness)
//  steps     : step size after each frame relative to a normal step (for retiming)
//  loops     : best sub-ranges [a, b] whose b → a transition looks like a normal step
export function analyze(samples, { minLoop = 8 } = {}) {
  const n = samples.length;
  if (n < 3) return { score: samples.map(() => 1), seam: 1, steps: samples.map(() => 1), loops: [] };
  const D = (i, j) => diff(samples[i], samples[j]);
  const step = [];
  for (let i = 0; i < n - 1; i++) step.push(D(i, i + 1));
  const typical = median(step) || 1e-6;
  // Two signals, the stronger one counts:
  //  - neighbours: a bad frame differs from BOTH neighbours (real fast motion usually only from one)
  //  - consensus: a bad frame doesn't match the median of the whole sequence (wrong scene, wrong framing)
  const cons = (() => {
    const ref = { ...medianOfSamples(samples), n: samples[0].n };
    const d = samples.map((s) => diff(ref, s));
    const typ = median(d) || 1e-6;
    return d.map((v) => v / typ);
  })();
  const score = samples.map((_, i) => {
    const l = i > 0 ? step[i - 1] : Infinity, r = i < n - 1 ? step[i] : Infinity;
    return Math.max(Math.min(l, r) / typical, cons[i]);
  });
  const seam = D(n - 1, 0) / typical;
  const steps = [...step, D(n - 1, 0)].map((v) => v / typical);
  const loops = [];
  for (let a = 0; a < n; a++) for (let b = a + minLoop - 1; b < n; b++) {
    loops.push({ a, b, seam: D(b, a) / typical, len: b - a + 1 });
  }
  // a seam no bigger than a normal step is invisible; among those, longer loops win
  const bad = (l) => Math.max(0, l.seam - 1);
  loops.sort((p, q) => bad(p) - bad(q) || q.len - p.len);
  const picked = [];
  for (const l of loops) { // skip near-duplicates of a range already listed
    if (picked.some((p) => Math.abs(p.a - l.a) <= 2 && Math.abs(p.b - l.b) <= 2)) continue;
    picked.push(l);
    if (picked.length === 5) break;
  }
  return { score, seam, steps, loops: picked };
}

function medianOfSamples(ss) {
  const n = ss[0].n, gray = new Float32Array(n), m = new Uint8Array(n), buf = new Float32Array(ss.length);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (const s of ss) if (s.m[i]) buf[k++] = s.gray[i];
    if (k * 2 < ss.length) continue;
    gray[i] = buf.subarray(0, k).sort()[k >> 1]; m[i] = 1;
  }
  return { gray, m };
}
