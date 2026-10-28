import { quadAspect, quadSize, rectToQuad } from './geometry.js';
import type { Quad, RGBAImage } from './types.js';

export interface WarpOptions {
  /** Long side of the output is capped at this. Default 2480 (A4 at 300 dpi). */
  maxSide?: number;
  /** Force an output size instead of deriving it from the quad. */
  width?: number;
  height?: number;
}

/** Flattens the quad `corners` of `img` into an upright rectangle (perspective correction, bilinear sampling). */
export function warpPerspective(img: RGBAImage, corners: Quad, opts: WarpOptions = {}): RGBAImage {
  const { maxSide = 2480 } = opts;
  let { width: W, height: H } = opts.width && opts.height ? { width: opts.width, height: opts.height } : quadSize(corners);
  if (!(opts.width && opts.height)) {
    // the edges of a tilted sheet are foreshortened: without this the page comes out stretched
    const aspect = quadAspect(corners, img.width, img.height);
    if (aspect) {
      if (W / H > aspect) W = H * aspect;
      else H = W / aspect;
    }
  }
  const k = Math.min(1, maxSide / Math.max(W, H));
  W = Math.max(1, Math.round(W * k));
  H = Math.max(1, Math.round(H * k));

  const [h0, h1, h2, h3, h4, h5, h6, h7] = rectToQuad(W, H, corners);
  const { data: src, width: sw, height: sh } = img;
  const out = new Uint8ClampedArray(W * H * 4);
  const maxX = sw - 1, maxY = sh - 1;

  for (let y = 0; y < H; y++) {
    const yc = y + 0.5;
    for (let x = 0; x < W; x++) {
      const xc = x + 0.5;
      const d = h6 * xc + h7 * yc + 1;
      let u = (h0 * xc + h1 * yc + h2) / d - 0.5;
      let v = (h3 * xc + h4 * yc + h5) / d - 0.5;
      u = u < 0 ? 0 : u > maxX ? maxX : u;
      v = v < 0 ? 0 : v > maxY ? maxY : v;
      const x0 = u | 0, y0 = v | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = u - x0, fy = v - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}
