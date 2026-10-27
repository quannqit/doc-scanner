import type { RGBAImage } from './types.js';

/** Per output index: the input indices it covers and their weights (exact area overlap). */
function areaWeights(from: number, to: number) {
  const ratio = from / to;
  const idx: number[][] = [], wts: number[][] = [];
  for (let o = 0; o < to; o++) {
    const start = o * ratio, end = (o + 1) * ratio;
    const ii: number[] = [], ww: number[] = [];
    for (let i = Math.floor(start); i < Math.min(from, Math.ceil(end)); i++) {
      const wgt = Math.min(end, i + 1) - Math.max(start, i);
      if (wgt > 1e-6) ii.push(i), ww.push(wgt / ratio);
    }
    idx.push(ii);
    wts.push(ww);
  }
  return { idx, wts };
}

/**
 * Downscale so the long side is at most `maxSide`, averaging the exact area each output pixel covers (no
 * aliasing at awkward ratios). Returns the input when it is already small enough.
 */
export function downscale(img: RGBAImage, maxSide: number): { image: RGBAImage; scale: number } {
  const { width: w, height: h, data } = img;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (scale === 1) return { image: img, scale };
  const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
  const X = areaWeights(w, W), Y = areaWeights(h, H);
  // horizontal pass into floats, then vertical
  const tmp = new Float32Array(W * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      const ii = X.idx[x], ww = X.wts[x];
      for (let k = 0; k < ii.length; k++) {
        const i = (y * w + ii[k]) * 4, wt = ww[k];
        r += data[i] * wt;
        g += data[i + 1] * wt;
        b += data[i + 2] * wt;
      }
      const o = (y * W + x) * 3;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
    }
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const ii = Y.idx[y], ww = Y.wts[y];
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < ii.length; k++) {
        const i = (ii[k] * W + x) * 3, wt = ww[k];
        r += tmp[i] * wt;
        g += tmp[i + 1] * wt;
        b += tmp[i + 2] * wt;
      }
      const o = (y * W + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return { image: { data: out, width: W, height: H }, scale: W / w };
}

/** Summed-area table of a 0/1 mask, (w+1)x(h+1). */
function integral(mask: Uint8Array, w: number, h: number): Int32Array {
  const s = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x];
      s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row;
    }
  }
  return s;
}

/**
 * Binary dilation (`erode = false`) or erosion with a square of radius r, in O(pixels).
 * Pixels beyond the border count as background for dilation and foreground for erosion,
 * so closing does not eat into shapes that touch the edge.
 */
export function morph(mask: Uint8Array, w: number, h: number, r: number, erode: boolean): Uint8Array {
  const s = integral(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = s[y1 * (w + 1) + x1] - s[y0 * (w + 1) + x1] - s[y1 * (w + 1) + x0] + s[y0 * (w + 1) + x0];
      out[y * w + x] = erode ? (sum === (x1 - x0) * (y1 - y0) ? 1 : 0) : sum > 0 ? 1 : 0;
    }
  }
  return out;
}

/** Otsu threshold of a 256-bin histogram. */
export function otsu(hist: ArrayLike<number>): number {
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) (total += hist[i]), (sum += i * hist[i]);
  let wB = 0, sumB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) (best = between), (t = i);
  }
  return t;
}
