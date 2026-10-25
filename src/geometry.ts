import type { Point, Quad } from './types.js';

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Signed area; positive when the vertices run counter-clockwise in y-up axes (clockwise on screen). */
export function polygonArea(p: Point[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Andrew's monotone chain. Returns the hull with positive `polygonArea`, without collinear points. */
export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function lineIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
  return { x: a1.x + t * (a2.x - a1.x), y: a1.y + t * (a2.y - a1.y) };
}

/**
 * Shrinks a convex polygon to 4 vertices by repeatedly dropping the edge whose removal (extending its two
 * neighbours until they meet) adds the least area. The result encloses the input, so a corner that was cut
 * off — by a cable lying across the paper, say — is restored rather than shaved further.
 */
export function enclosingQuad(hull: Point[]): Point[] | null {
  let p = hull.slice();
  if (p.length < 4) return null;
  while (p.length > 4) {
    const n = p.length;
    let best = -1, bestCost = Infinity, bestPoint: Point | null = null;
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n], d = p[(i + 2) % n];
      const x = lineIntersection(a, b, c, d);
      // the new vertex must lie outside edge b→c (right of it for this orientation)
      if (!x || cross(b, c, x) > 0) continue;
      const cost = Math.abs(cross(b, x, c)) / 2;
      if (cost < bestCost) (bestCost = cost), (best = i), (bestPoint = x);
    }
    if (best < 0 || !bestPoint) {
      // fallback: drop the vertex contributing the least area
      let k = 0, min = Infinity;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(cross(p[(i - 1 + n) % n], p[i], p[(i + 1) % n]));
        if (a < min) (min = a), (k = i);
      }
      p.splice(k, 1);
    } else {
      const next = (best + 1) % n;
      p[best] = bestPoint;
      p.splice(next, 1);
    }
  }
  return p;
}

/** Orders 4 points as top-left, top-right, bottom-right, bottom-left. */
export function orderQuad(pts: Point[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // angles go clockwise on screen starting near -180° (left); rotate so the top-left (smallest x+y) comes first
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  const q = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
  return q as Quad;
}

/** Interior angles in degrees. */
export function quadAngles(q: Quad): number[] {
  return q.map((p, i) => {
    const a = q[(i + 3) % 4], b = q[(i + 1) % 4];
    const v1 = { x: a.x - p.x, y: a.y - p.y }, v2 = { x: b.x - p.x, y: b.y - p.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  });
}

export function isConvex(q: Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const c = cross(q[i], q[(i + 1) % q.length], q[(i + 2) % q.length]);
    if (c === 0) return false;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Output size for flattening a quad: the longer of each pair of opposite edges. */
export function quadSize(q: Quad): { width: number; height: number } {
  return {
    width: Math.max(dist(q[0], q[1]), dist(q[3], q[2])),
    height: Math.max(dist(q[0], q[3]), dist(q[1], q[2])),
  };
}

/**
 * Homography mapping the rectangle (0,0)-(w,h) onto `q`. Returns the 8 coefficients h such that
 * x' = (h0 x + h1 y + h2) / (h6 x + h7 y + 1), y' = (h3 x + h4 y + h5) / (h6 x + h7 y + 1).
 */
export function rectToQuad(w: number, h: number, q: Quad): number[] {
  const src = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8x9 augmented matrix
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c] || 1e-12;
    for (let k = c; k < 9; k++) A[c][k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row) => row[8]);
}

export function scaleQuad(q: Quad, sx: number, sy = sx): Quad {
  return q.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad;
}

/** A rectangle inset from the image edges — a sensible starting point when nothing was detected. */
export function defaultQuad(width: number, height: number, inset = 0.08): Quad {
  const dx = width * inset, dy = height * inset;
  return [
    { x: dx, y: dy },
    { x: width - dx, y: dy },
    { x: width - dx, y: height - dy },
    { x: dx, y: height - dy },
  ];
}
