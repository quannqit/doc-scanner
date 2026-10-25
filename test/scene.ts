import type { Point, Quad, RGBAImage } from '../src/types.js';

function inside(q: Point[], x: number, y: number) {
  let c = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++)
    if (q[i].y > y !== q[j].y > y && x < ((q[j].x - q[i].x) * (y - q[i].y)) / (q[j].y - q[i].y) + q[i].x) c = !c;
  return c;
}

/** Brown cardboard, a white floor strip along the top edge, a tilted sheet with text lines, a dark cable over its left edge. */
export function scene(w: number, h: number, paper: Quad, opts: { occluder?: boolean; floor?: boolean } = {}): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 16;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c = [175, 135, 95];
      if (opts.floor !== false && y < h * 0.15) c = [232, 232, 230];
      if (inside(paper, x, y)) {
        c = [240, 238, 235];
        // text lines
        const v = (y - paper[0].y) % 24;
        if (v > 10 && v < 14 && (x / 9) % 3 > 1) c = [40, 40, 50];
      }
      if (opts.occluder !== false && Math.abs(x - (paper[0].x + 4 + (y - paper[0].y) * 0.05)) < 7 && y > h * 0.3 && y < h * 0.7) c = [20, 20, 20];
      const i = (y * w + x) * 4;
      data[i] = c[0] + rnd();
      data[i + 1] = c[1] + rnd();
      data[i + 2] = c[2] + rnd();
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}
