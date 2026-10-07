// Frame rendering shared by the editor preview, playback and export, so what you see is what gets encoded.
// A frame transform is {x, y, scale, rotation}: image centred on the project canvas, then shifted by x/y (px),
// rotated (degrees) and scaled around its own centre. This is the FRAME transform, not the editor viewport.

export const IDENTITY = { x: 0, y: 0, scale: 1, rotation: 0 };

// Edge-extend source: image padded by stretching its border pixels outward. Cached, small LRU.
// ponytail: fixed pad of 15% of the image size; transforms exposing more than that show transparency there.
const padCache = new Map();
const PAD_CACHE_MAX = 16;

function padded(img) {
  let c = padCache.get(img);
  if (c) { padCache.delete(img); padCache.set(img, c); return c; }
  const w = img.naturalWidth, h = img.naturalHeight, p = Math.ceil(Math.max(w, h) * 0.15);
  c = document.createElement("canvas");
  c.width = w + 2 * p; c.height = h + 2 * p; c.pad = p;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.drawImage(img, p, p);
  g.drawImage(img, 0, 0, w, 1, p, 0, w, p);              // top
  g.drawImage(img, 0, h - 1, w, 1, p, p + h, w, p);      // bottom
  g.drawImage(img, 0, 0, 1, h, 0, p, p, h);              // left
  g.drawImage(img, w - 1, 0, 1, h, p + w, p, p, h);      // right
  g.drawImage(img, 0, 0, 1, 1, 0, 0, p, p);              // corners
  g.drawImage(img, w - 1, 0, 1, 1, p + w, 0, p, p);
  g.drawImage(img, 0, h - 1, 1, 1, 0, p + h, p, p);
  g.drawImage(img, w - 1, h - 1, 1, 1, p + w, p + h, p, p);
  padCache.set(img, c);
  if (padCache.size > PAD_CACHE_MAX) padCache.delete(padCache.keys().next().value);
  return c;
}

// Draw one transformed frame onto ctx whose size is the project canvas.
export function drawFrame(ctx, img, t, background = "clamp") {
  if (!img || !img.complete || !img.naturalWidth) return;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.save();
  ctx.translate(W / 2 + t.x, H / 2 + t.y);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(t.scale, t.scale);
  if (background === "clamp") {
    const c = padded(img);
    ctx.drawImage(c, -c.width / 2, -c.height / 2);
  } else {
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  }
  ctx.restore();
}

// Full composited frame, used for export: background fill + transformed frame.
export function renderExport(ctx, img, t, background) {
  const { width: W, height: H } = ctx.canvas;
  ctx.clearRect(0, 0, W, H);
  if (background === "black") { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); }
  drawFrame(ctx, img, t, background);
}
