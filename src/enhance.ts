import type { EnhanceMode, RGBAImage } from './types.js';

/**
 * Estimates the paper colour under each pixel: the brightest value in coarse blocks (which wipes out ink),
 * spread over neighbouring blocks and smoothed. Returned as a small grid sampled bilinearly by the caller.
 */
function backgroundGrid(chan: Float32Array, w: number, h: number, block: number) {
  const gw = Math.ceil(w / block), gh = Math.ceil(h / block);
  const g = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = ((y / block) | 0) * gw;
    for (let x = 0; x < w; x++) {
      const v = chan[y * w + x], k = gy + ((x / block) | 0);
      if (v > g[k]) g[k] = v;
    }
  }
  // dilate two blocks (large headings, thick stamps) then two box-blur passes
  const dil = new Float32Array(g.length);
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      let m = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < gh && xx >= 0 && xx < gw && g[yy * gw + xx] > m) m = g[yy * gw + xx];
        }
      dil[y * gw + x] = m;
    }
  let cur = dil;
  for (let pass = 0; pass < 2; pass++) {
    const nxt = new Float32Array(cur.length);
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) (s += cur[yy * gw + xx]), c++;
          }
        nxt[y * gw + x] = s / c;
      }
    cur = nxt;
  }
  return { grid: cur, gw, gh };
}

function sampler(grid: Float32Array, gw: number, gh: number, block: number) {
  return (x: number, y: number) => {
    let gx = (x + 0.5) / block - 0.5, gy = (y + 0.5) / block - 0.5;
    gx = gx < 0 ? 0 : gx > gw - 1 ? gw - 1 : gx;
    gy = gy < 0 ? 0 : gy > gh - 1 ? gh - 1 : gy;
    const x0 = gx | 0, y0 = gy | 0, x1 = Math.min(x0 + 1, gw - 1), y1 = Math.min(y0 + 1, gh - 1);
    const fx = gx - x0, fy = gy - y0;
    const a = grid[y0 * gw + x0] + (grid[y0 * gw + x1] - grid[y0 * gw + x0]) * fx;
    const b = grid[y1 * gw + x0] + (grid[y1 * gw + x1] - grid[y1 * gw + x0]) * fx;
    return a + (b - a) * fy;
  };
}

/** Maps paper-relative brightness (1 = paper) to output: paper goes pure white, ink gets darker. */
const levels = (r: number, lo: number, hi: number) => {
  const t = (r - lo) / (hi - lo);
  return t <= 0 ? 0 : t >= 1 ? 255 : 255 * Math.pow(t, 1.25);
};

/**
 * Scanner-style clean-up: removes shadows and uneven lighting by dividing by the estimated paper colour,
 * then pushes the paper to white. Returns a new image; `original` returns the input untouched.
 */
export function enhance(img: RGBAImage, mode: EnhanceMode = 'color'): RGBAImage {
  if (mode === 'original') return img;
  const { width: w, height: h, data } = img;
  const n = w * h;
  const block = Math.max(8, Math.round(Math.max(w, h) / 60));
  const out = new Uint8ClampedArray(n * 4);

  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  const { grid, gw, gh } = backgroundGrid(gray, w, h, block);
  const bg = sampler(grid, gw, gh, block);
  const [lo, hi] = mode === 'bw' ? [0.62, 0.8] : [0.25, 0.9];

  if (mode === 'color') {
    // One lighting estimate for all channels (per-channel estimates leave tinted patches around coloured ink),
    // plus a global white balance taken from pixels that look like bare paper.
    const sum = [0, 0, 0];
    let count = 0;
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w; x += 2) {
        const i = y * w + x;
        if (gray[i] > 0.92 * bg(x, y)) (sum[0] += data[i * 4]), (sum[1] += data[i * 4 + 1]), (sum[2] += data[i * 4 + 2]), count++;
      }
    const paperL = count ? (0.299 * sum[0] + 0.587 * sum[1] + 0.114 * sum[2]) / count : 1;
    const gain = sum.map((s) => (count && s ? paperL / (s / count) : 1));
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const b = Math.max(1, bg(x, y));
        for (let c = 0; c < 3; c++) out[i * 4 + c] = levels((data[i * 4 + c] * gain[c]) / b, lo, hi);
        out[i * 4 + 3] = 255;
      }
    return { data: out, width: w, height: h };
  }

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = levels(gray[i] / Math.max(1, bg(x, y)), lo, hi);
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
      out[i * 4 + 3] = 255;
    }
  return { data: out, width: w, height: h };
}
