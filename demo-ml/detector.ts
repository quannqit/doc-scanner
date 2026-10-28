// Model plumbing for the browser playground: the same preprocessing and heatmap decoding the
// Node evaluation used, so the browser numbers are comparable with the offline ones.
import { orderQuad } from '../src/geometry.js';
import type { Point, Quad } from '../src/types.js';

/** The model's fixed input: square, stretched (never letterboxed — that makes it detect the padding). */
export const SIZE = 256;

/** RGBA pixels -> 3 planes of SIZE x SIZE floats in 0..1, stretched to a square. */
export function buildInput(img: ImageData): Float32Array {
  const out = new Float32Array(3 * SIZE * SIZE);
  const { width: W, height: H, data } = img;
  const sx = W / SIZE, sy = H / SIZE;
  for (let y = 0; y < SIZE; y++) {
    const fy = Math.min(H - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < SIZE; x++) {
      const fx = Math.min(W - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const v = (data[(y0 * W + x0) * 4 + c] * (1 - wx) + data[(y0 * W + x1) * 4 + c] * wx) * (1 - wy)
          + (data[(y1 * W + x0) * 4 + c] * (1 - wx) + data[(y1 * W + x1) * 4 + c] * wx) * wy;
        out[c * SIZE * SIZE + y * SIZE + x] = v / 255;
      }
    }
  }
  return out;
}

/** Centroid of the largest 8-connected blob above `threshold` in one heatmap channel. */
function peak(map: Float32Array, w: number, h: number, threshold: number): Point | null {
  const label = new Int32Array(w * h);
  let best: { n: number; sx: number; sy: number } | null = null;
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (label[i] || map[i] < threshold) continue;
    let n = 0, sx = 0, sy = 0;
    label[i] = 1;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!, x = j % w, y = (j - x) / w;
      n++; sx += x; sy += y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, k = yy * w + xx;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || label[k] || map[k] < threshold) continue;
        label[k] = 1;
        stack.push(k);
      }
    }
    if (!best || n > best.n) best = { n, sx, sy };
  }
  return best && { x: best.sx / best.n, y: best.sy / best.n };
}

/**
 * Heatmaps [4][hh][hw] -> corners in image pixels, or null when any corner has no confident peak.
 * `imgW`/`imgH` are the dimensions the input was stretched from.
 */
export function decodeHeatmap(heat: Float32Array, hh: number, hw: number, imgW: number, imgH: number, threshold = 0.3): Quad | null {
  const pts: Point[] = [];
  for (let c = 0; c < 4; c++) {
    const p = peak(heat.subarray(c * hh * hw, (c + 1) * hh * hw), hw, hh, threshold);
    if (!p) return null;
    pts.push({ x: ((p.x + 0.5) * imgW) / hw - 0.5, y: ((p.y + 0.5) * imgH) / hh - 0.5 });
  }
  return orderQuad(pts);
}
