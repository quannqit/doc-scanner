import { describe, expect, it } from 'vitest';
import { quadAspect, warpPerspective } from '../src/index.js';
import type { Quad } from '../src/types.js';

/** Pinhole projection of a W x H rectangle lying on z = 0, with the principal point at the image centre. */
function project(W: number, H: number, tiltX: number, tiltY: number, distance: number, imgW: number, imgH: number): Quad {
  const cx = imgW / 2, cy = imgH / 2, f = Math.max(imgW, imgH) * 1.1;
  const ca = Math.cos(tiltX), sa = Math.sin(tiltX), cb = Math.cos(tiltY), sb = Math.sin(tiltY);
  const R = [
    cb, sb * sa, sb * ca,
    0, ca, -sa,
    -sb, cb * sa, cb * ca,
  ];
  const pts = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  return pts.map((p) => {
    const X = [p.x - W / 2, p.y - H / 2, 0];
    const c = [0, 1, 2].map((i) => R[i * 3] * X[0] + R[i * 3 + 1] * X[1] + R[i * 3 + 2] * X[2] + (i === 2 ? distance : 0));
    return { x: (f * c[0]) / c[2] + cx, y: (f * c[1]) / c[2] + cy };
  }) as Quad;
}

const A4 = { w: 1000, h: 1414 }; // ratio 0.7071, portrait

describe('quadAspect', () => {
  it('recovers the page proportions from a tilted view', () => {
    for (const [tx, ty] of [[0.25, 0.12], [0.4, -0.2], [0.1, 0.05]]) {
      const q = project(A4.w, A4.h, tx, ty, 2600, 1600, 2000);
      const r = quadAspect(q, 1600, 2000);
      expect(r).not.toBeNull();
      expect(Math.abs(r! - A4.w / A4.h)).toBeLessThan(0.01);
    }
  });

  it('declines when the shot has no perspective', () => {
    // opposite sides parallel: the ratio is not recoverable from the four corners
    const flat: Quad = [{ x: 100, y: 100 }, { x: 800, y: 100 }, { x: 800, y: 1090 }, { x: 100, y: 1090 }];
    expect(quadAspect(flat, 1600, 2000)).toBeNull();
  });
});

describe('warpPerspective output proportions', () => {
  it('renders a tilted A4 as A4, not as its foreshortened silhouette', () => {
    const q = project(A4.w, A4.h, 0.3, 0.15, 2500, 1600, 2000);
    const flat = warpPerspective({ width: 1600, height: 2000, data: new Uint8ClampedArray(1600 * 2000 * 4) }, q, { maxSide: 500 });
    expect(flat.height).toBe(500);
    expect(Math.abs(flat.width / flat.height - A4.w / A4.h)).toBeLessThan(0.01);
  });

  it('keeps the edge lengths when the caller forces a size', () => {
    const q = project(A4.w, A4.h, 0.3, 0.15, 2500, 1600, 2000);
    const flat = warpPerspective({ width: 1600, height: 2000, data: new Uint8ClampedArray(1600 * 2000 * 4) }, q, { width: 400, height: 200 });
    expect(flat.width).toBe(400);
    expect(flat.height).toBe(200);
  });
});
