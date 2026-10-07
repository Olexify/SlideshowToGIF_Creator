// Automatic alignment and frame-quality analysis.
// Everything works on small grayscale renders of frames *with their transforms applied*, using the same
// transform math as render.js: image centred on a W×H canvas, shifted by x/y, rotated and scaled around its centre.

const CAP = 0.15; // per-pixel difference cap (0..1): moving parts of the drawing shouldn't dominate the match

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
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    m[i] = d[j + 3] > 250 ? 1 : 0;
    gray[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255;
  }
  return { gray, m, n };
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

// Pattern search (coordinate descent with shrinking steps), coarse to fine.
// Returns the transform for `img` that best matches the reference render.
export async function align(refImg, refT, img, start, W, H, { scale = true, rotation = true, shouldStop = () => false } = {}) {
  let t = { ...start };
  for (const size of [96, 224]) {
    const ref = sample(refImg, refT, W, H, size);
    const px = W / size; // one sample pixel in canvas px
    const cost = (c) => diff(ref, sample(img, c, W, H, size));
    let best = cost(t);
    const steps = { x: 4 * px, y: 4 * px, scale: 0.02, rotation: 1 };
    const min = { x: 0.25 * px, y: 0.25 * px, scale: 0.0005, rotation: 0.02 };
    const keys = ["x", "y", ...(scale ? ["scale"] : []), ...(rotation ? ["rotation"] : [])];
    if (size > 96) for (const k of keys) steps[k] /= 4;
    for (let evals = 0; evals < 400 && keys.some((k) => steps[k] >= min[k]); ) {
      let moved = false;
      for (const k of keys) {
        if (steps[k] < min[k]) continue;
        for (const dir of [1, -1]) {
          const c = { ...t, [k]: t[k] + dir * steps[k] };
          if (c.scale < 0.5 || c.scale > 2 || Math.abs(c.rotation) > 20) continue;
          const v = cost(c); evals++;
          if (v < best - 1e-6) { best = v; t = c; moved = true; break; }
        }
      }
      if (!moved) for (const k of keys) steps[k] /= 2;
      if (evals % 40 === 0) { await new Promise((r) => setTimeout(r)); if (shouldStop()) return t; } // keep the UI alive
    }
  }
  return {
    x: Math.round(t.x * 100) / 100, y: Math.round(t.y * 100) / 100,
    scale: Math.round(t.scale * 10000) / 10000, rotation: Math.round(t.rotation * 10000) / 10000,
  };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

// Quality of an aligned sequence.
//  score[i]  : how much frame i jumps compared with a normal step (≈1 normal, ≫1 suspicious)
//  seam      : last → first step relative to a normal step (loop smoothness)
//  loops     : best sub-ranges [a, b] whose b → a transition looks like a normal step
export function analyze(samples, { minLoop = 8 } = {}) {
  const n = samples.length;
  if (n < 3) return { score: samples.map(() => 1), seam: 1, step: 0, loops: [] };
  const D = (i, j) => diff(samples[i], samples[j]);
  const step = [];
  for (let i = 0; i < n - 1; i++) step.push(D(i, i + 1));
  const typical = median(step) || 1e-6;
  // A bad frame differs from BOTH neighbours, while a fast but genuine motion usually differs from just one,
  // so score by the smaller of the two steps (ends only have one neighbour).
  const score = samples.map((_, i) => {
    const l = i > 0 ? step[i - 1] : Infinity, r = i < n - 1 ? step[i] : Infinity;
    return Math.min(l, r) / typical;
  });
  const seam = D(n - 1, 0) / typical;
  const loops = [];
  for (let a = 0; a < n; a++) for (let b = a + minLoop - 1; b < n; b++) {
    const s = D(b, a) / typical;
    loops.push({ a, b, seam: s, len: b - a + 1 });
  }
  // a seam no bigger than a normal step is invisible; among those, longer loops win
  const bad = (l) => Math.max(0, l.seam - 1);
  loops.sort((p, q) => bad(p) - bad(q) || q.len - p.len);
  const picked = [];
  for (const l of loops) { // skip near-duplicates of a range already listed
    if (picked.some((p) => Math.abs(p.a - l.a) <= 1 && Math.abs(p.b - l.b) <= 1)) continue;
    picked.push(l);
    if (picked.length === 5) break;
  }
  return { score, seam, step: typical, loops: picked };
}
