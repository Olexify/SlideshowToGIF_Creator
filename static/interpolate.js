// In-between frames by motion-compensated interpolation.
//  1. dense motion A→B and B→A: coarse-to-fine block matching on small grayscale copies,
//     sub-pixel refinement, then smoothing so the field doesn't tear
//  2. frame at time t: A pulled forward along its motion, B pulled back along its motion, blended
// Works on full-size RGBA ImageData of the two frames as they are rendered for export (already aligned).

const BLOCK = 8;     // block size in small-image px
const RADIUS = 3;    // search radius around the coarser level's estimate
const WIDE = 10;     // the coarsest level searches widely: ±10 px at 80 px wide ≈ ±12% of the frame width
const SMALL = 320;   // motion is estimated at this width

function toGray(data, W, H, w, h) {
  // box-average downsample of RGBA into w×h grayscale
  const g = new Float32Array(w * h), sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let yy = y0; yy < y1; yy += 1) for (let xx = x0; xx < x1; xx += 1) {
      const j = (yy * W + xx) * 4;
      s += 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]; c++;
    }
    g[y * w + x] = s / c;
  }
  return g;
}

function half(g, w, h) {
  const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1), o = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const i = 2 * y * w + 2 * x;
    o[y * w2 + x] = (g[i] + g[i + 1 < w * h ? i + 1 : i] + g[i + w < w * h ? i + w : i] + g[i + w + 1 < w * h ? i + w + 1 : i]) / 4;
  }
  return { g: o, w: w2, h: h2 };
}

const at = (g, w, h, x, y) => g[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];

// Block-matching flow from a to b at one level, starting from a prediction (fx, fy per block).
function matchLevel(a, b, w, h, gw, gh, fx, fy, R = RADIUS) {
  const ox = new Float32Array(gw * gh), oy = new Float32Array(gw * gh);
  for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
    const k = by * gw + bx, x0 = bx * BLOCK, y0 = by * BLOCK;
    const px = Math.round(fx[k]), py = Math.round(fy[k]);
    let best = Infinity, bdx = px, bdy = py;
    const cost = new Map();
    for (let dy = py - R; dy <= py + R; dy++) for (let dx = px - R; dx <= px + R; dx++) {
      let s = 0;
      for (let y = 0; y < BLOCK; y++) for (let x = 0; x < BLOCK; x++) {
        s += Math.abs(at(a, w, h, x0 + x, y0 + y) - at(b, w, h, x0 + x + dx, y0 + y + dy));
      }
      s += 2 * (Math.abs(dx - fx[k]) + Math.abs(dy - fy[k])); // mild pull towards the prediction: flat areas stay put
      cost.set(dx + "," + dy, s);
      if (s < best) { best = s; bdx = dx; bdy = dy; }
    }
    // sub-pixel: parabola through the neighbours of the minimum
    const c = (dx, dy) => cost.get(dx + "," + dy);
    let sx = 0, sy = 0;
    const l = c(bdx - 1, bdy), r = c(bdx + 1, bdy), u = c(bdx, bdy - 1), d = c(bdx, bdy + 1);
    if (l !== undefined && r !== undefined && l + r - 2 * best > 0) sx = (l - r) / (2 * (l + r - 2 * best));
    if (u !== undefined && d !== undefined && u + d - 2 * best > 0) sy = (u - d) / (2 * (u + d - 2 * best));
    ox[k] = bdx + Math.max(-0.5, Math.min(0.5, sx));
    oy[k] = bdy + Math.max(-0.5, Math.min(0.5, sy));
  }
  return [ox, oy];
}

function smooth(f, gw, gh, mean = true) {
  // 3×3 median (kills outlier blocks), then a 3×3 mean
  const med = new Float32Array(f.length), out = new Float32Array(f.length), v = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    v.length = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) v.push(at(f, gw, gh, x + i, y + j));
    v.sort((p, q) => p - q);
    med[y * gw + x] = v[4];
  }
  if (!mean) return med;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let s = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += at(med, gw, gh, x + i, y + j);
    out[y * gw + x] = s / 9;
  }
  return out;
}

// Flow field from a to b (grayscale, w×h): per-block displacement in small-image px.
function flow(a, b, w, h) {
  const pyr = [{ a, b, w, h }];
  while (pyr[pyr.length - 1].w >= 160) { // down to ~80 px wide
    const p = pyr[pyr.length - 1], ha = half(p.a, p.w, p.h), hb = half(p.b, p.w, p.h);
    pyr.push({ a: ha.g, b: hb.g, w: ha.w, h: ha.h });
  }
  let fx = null, fy = null, pgw = 0, pgh = 0;
  for (let L = pyr.length - 1; L >= 0; L--) {
    const { a: la, b: lb, w: lw, h: lh } = pyr[L];
    const gw = Math.ceil(lw / BLOCK), gh = Math.ceil(lh / BLOCK);
    // prediction: previous (coarser) field, upsampled and doubled
    const px = new Float32Array(gw * gh), py = new Float32Array(gw * gh);
    if (fx) for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const k = y * gw + x, X = Math.min(pgw - 1, x >> 1), Y = Math.min(pgh - 1, y >> 1);
      px[k] = 2 * fx[Y * pgw + X]; py[k] = 2 * fy[Y * pgw + X];
    }
    [fx, fy] = matchLevel(la, lb, lw, lh, gw, gh, px, py, L === pyr.length - 1 ? WIDE : RADIUS);
    // finest level: median only, so the background's motion doesn't bleed into a moving shape's edges
    fx = smooth(fx, gw, gh, L > 0); fy = smooth(fy, gw, gh, L > 0);
    pgw = gw; pgh = gh;
  }
  return { fx, fy, gw: pgw, gh: pgh };
}

// bilinear lookup of a block field at small-image position (x, y)
function field(F, x, y) {
  const gx = Math.min(F.gw - 1, Math.max(0, x / BLOCK - 0.5)), gy = Math.min(F.gh - 1, Math.max(0, y / BLOCK - 0.5));
  const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(F.gw - 1, x0 + 1), y1 = Math.min(F.gh - 1, y0 + 1);
  const tx = gx - x0, ty = gy - y0;
  const lerp = (f) => (f[y0 * F.gw + x0] * (1 - tx) + f[y0 * F.gw + x1] * tx) * (1 - ty)
    + (f[y1 * F.gw + x0] * (1 - tx) + f[y1 * F.gw + x1] * tx) * ty;
  return [lerp(F.fx), lerp(F.fy)];
}

function sampleRGBA(d, W, H, x, y, out, o) {
  x = Math.min(W - 1, Math.max(0, x)); y = Math.min(H - 1, Math.max(0, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
  for (let c = 0; c < 4; c++) {
    out[o + c] = (d[i00 + c] * (1 - tx) + d[i10 + c] * tx) * (1 - ty) + (d[i01 + c] * (1 - tx) + d[i11 + c] * tx) * ty;
  }
}

// Motion at time t, per small-image pixel: every pixel of A is pushed forward by t·(A→B motion) and every
// pixel of B back by (1-t)·(B→A motion); each lands on a cell of the in-between frame and leaves its motion
// there. Where two land on the same cell the larger motion wins (the moving subject is in front of a static
// background); empty cells are filled from their neighbours.
function motionAt(fab, fba, w, h, t) {
  const fx = new Float32Array(w * h), fy = new Float32Array(w * h), mag = new Float32Array(w * h).fill(-1);
  const splat = (x, y, ux, uy) => {
    const X = Math.round(x), Y = Math.round(y);
    if (X < 0 || Y < 0 || X >= w || Y >= h) return;
    const k = Y * w + X, m = ux * ux + uy * uy;
    if (m > mag[k]) { mag[k] = m; fx[k] = ux; fy[k] = uy; }
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [ux, uy] = field(fab, x, y); splat(x + t * ux, y + t * uy, ux, uy);
    const [vx, vy] = field(fba, x, y); splat(x + (1 - t) * vx, y + (1 - t) * vy, -vx, -vy);
  }
  for (let pass = 0; pass < 8; pass++) { // fill holes from filled neighbours
    let holes = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (mag[k] >= 0) continue;
      let sx = 0, sy = 0, c = 0;
      for (const [i, j] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const X = x + i, Y = y + j;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const q = Y * w + X;
        if (mag[q] >= 0 && mag[q] !== 1e9) { sx += fx[q]; sy += fy[q]; c++; }
      }
      if (c) { fx[k] = sx / c; fy[k] = sy / c; mag[k] = 1e9; } else holes++; // 1e9: filled this pass
    }
    for (let k = 0; k < mag.length; k++) if (mag[k] === 1e9) mag[k] = 0;
    if (!holes) break;
  }
  return { fx, fy };
}

function lerpField(M, w, h, x, y) {
  x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), tx = x - x0, ty = y - y0;
  const l = (f) => (f[y0 * w + x0] * (1 - tx) + f[y0 * w + x1] * tx) * (1 - ty) + (f[y1 * w + x0] * (1 - tx) + f[y1 * w + x1] * tx) * ty;
  return [l(M.fx), l(M.fy)];
}

// Prepare a pair once; then tween(t) for any number of in-betweens. method: "flow" | "fade".
export function pair(A, B, method = "flow") {
  const { width: W, height: H } = A;
  if (method === "fade") return { W, H, tween: (t) => blend(A.data, B.data, W, H, t) };
  const w = Math.min(SMALL, W), h = Math.max(1, Math.round((w * H) / W));
  const ga = toGray(A.data, W, H, w, h), gb = toGray(B.data, W, H, w, h);
  const fab = flow(ga, gb, w, h), fba = flow(gb, ga, w, h);
  const s = W / w; // small px -> full px
  return {
    W, H,
    tween(t) {
      const M = motionAt(fab, fba, w, h, t);
      const out = new Uint8ClampedArray(W * H * 4), a = new Float32Array(4), b = new Float32Array(4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const [ux, uy] = lerpField(M, w, h, x / s - 0.5, y / s - 0.5); // small px, A→B direction
        const ax = x / s - t * ux, ay = y / s - t * uy, bx = x / s + (1 - t) * ux, by = y / s + (1 - t) * uy;
        sampleRGBA(A.data, W, H, ax * s, ay * s, a, 0);
        sampleRGBA(B.data, W, H, bx * s, by * s, b, 0);
        // trust each side by how well the pixel taken from it really moves this way (if it doesn't,
        // it's hidden at time t); soft weights avoid speckle where the two sides trade over
        const [pax, pay] = field(fab, ax, ay), [pbx, pby] = field(fba, bx, by);
        const ea = (pax - ux) ** 2 + (pay - uy) ** 2, eb = (pbx + ux) ** 2 + (pby + uy) ** 2;
        const wa = (1 - t) * Math.exp(-ea / 2) + 1e-4, wb = t * Math.exp(-eb / 2) + 1e-4;
        const j = (y * W + x) * 4, n = wa + wb;
        for (let c = 0; c < 4; c++) out[j + c] = (a[c] * wa + b[c] * wb) / n;
      }
      return new ImageData(out, W, H);
    },
  };
}

function blend(a, b, W, H, t) {
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * (1 - t) + b[i] * t;
  return new ImageData(out, W, H);
}
