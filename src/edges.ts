import { isConvex, orderQuad, polygonArea, quadAngles } from './geometry.js';
import type { Point, Quad, RGBAImage } from './types.js';

export interface Gradients {
  w: number;
  h: number;
  gx: Float32Array;
  gy: Float32Array;
  mag: Float32Array;
}

/** Sobel gradients of the slightly blurred luminance. */
export function gradients(img: RGBAImage): Gradients {
  const { width: w, height: h, data } = img;
  const n = w * h;
  let g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  // two 3x3 box passes ≈ a small Gaussian: suppresses sensor noise and paper texture
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += g[yy * w + xx];
            c++;
          }
        }
        o[y * w + x] = s / c;
      }
    g = o;
  }
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
      const sx = c + 2 * f + r - a - 2 * d - p, sy = p + 2 * q + r - a - 2 * b - c;
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.hypot(sx, sy);
    }
  return { w, h, gx, gy, mag };
}

export interface Support {
  /** Mean support per side, 0–1. */
  sides: number[];
  /** Mean support over the stretch of each side next to each corner (8 values: side i start, side i end). */
  ends: number[];
  /** Support along each side's continuation past its corners (8 values, same order). */
  beyond: number[];
}

/**
 * How much of each side of `q` lies on an image edge running along that side: per sample, the gradient
 * component across the side, saturating at `full`. Gradients along the side (texture, text near the border)
 * do not count.
 *
 * Also reported, to tell a sheet's corner apart from look-alikes:
 * - `ends`: the stretch of each side next to each corner. A real corner has edge right up to it, while a quad
 *   that overshoots one (snapping to a floor tile line, say) does not.
 * - `beyond`: each side's continuation past each corner. At a sheet's corner both edges stop (an L), while a
 *   light or shadow boundary crossing the sheet carries on past the sheet's edges (a T or X).
 */
export function sideSupport(G: Gradients, q: Quad, opts: { full?: number; coarse?: boolean } = {}): Support {
  const { full = 40, coarse = false } = opts;
  const { w, h, gx, gy, mag } = G;
  const sides: number[] = [], ends: number[] = [], beyond: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / (len || 1), ny = (b.x - a.x) / (len || 1);

    /** Signed edge strength at parameter t along the side (0 = a, 1 = b), 0 when there is no step edge. */
    const sample = (t: number) => {
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      const at = (o: number) => {
        const x = Math.round(px + nx * o), y = Math.round(py + ny * o);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) return { v: 0, ok: false };
        const k = y * w + x, v = gx[k] * nx + gy[k] * ny;
        return { v, ok: Math.abs(v) >= 0.75 * mag[k] };
      };
      let best = 0, bestO = 0;
      for (let o = -1.5; o <= 1.5; o += 0.75) {
        const { v, ok } = at(o);
        if (ok && Math.abs(v) > Math.abs(best)) (best = v), (bestO = o);
      }
      if (!best) return 0;
      if (coarse) return Math.sign(best) * Math.min(1, Math.abs(best) / full);
      // A sheet's border is a step (one sign). A tile joint, grout or printed frame is a thin line: an edge of
      // the opposite sign and similar strength sits a few pixels away. Discount those.
      let opposite = 0;
      for (let o = bestO - 5; o <= bestO + 5; o += 1) {
        if (Math.abs(o - bestO) < 1.5) continue;
        const v = -Math.sign(best) * at(o).v;
        if (v > opposite) opposite = v;
      }
      const ratio = opposite / Math.abs(best);
      const step = ratio < 0.5 ? 1 : Math.max(0, 1 - (ratio - 0.5) / 0.4);
      return Math.sign(best) * Math.min(1, Math.abs(best) / full) * step;
    };
    const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / (v.length || 1);

    const steps = Math.max(10, Math.round(len / (coarse ? 6 : 2)));
    const raw: number[] = [];
    for (let s = 0; s <= steps; s++) raw.push(sample(0.03 + (0.94 * s) / steps)); // just clear of the corners
    // a sheet's border has the same polarity all along (paper on one side, background on the other); edges of
    // the opposite sign along the same side belong to something else, such as a cable lying across it
    const pos = raw.map((v) => Math.max(0, v)), neg = raw.map((v) => Math.max(0, -v));
    const sign = mean(pos) >= mean(neg) ? 1 : -1;
    const vals = sign > 0 ? pos : neg;
    const end = Math.max(2, Math.round(vals.length * 0.12));
    sides.push(mean(vals));
    ends.push(mean(vals.slice(0, end)), mean(vals.slice(-end)));

    if (coarse) {
      beyond.push(0, 0);
      continue;
    }
    const ext = Math.max(4, Math.round(steps * 0.12));
    const before: number[] = [], after: number[] = [];
    for (let s = 0; s < ext; s++) {
      const d = 0.04 + (0.12 * s) / ext;
      before.push(Math.max(0, sign * sample(-d)));
      after.push(Math.max(0, sign * sample(1 + d)));
    }
    beyond.push(mean(before), mean(after));
  }
  return { sides, ends, beyond };
}

interface Line {
  theta: number;
  rho: number;
  votes: number;
}

/** Straight edges via a gradient-oriented Hough transform (each edge pixel votes only near its own normal). */
export function houghLines(G: Gradients, maxLines: number): Line[] {
  const { w, h, gx, gy, mag } = G;
  const n = w * h;
  // edge pixels: local maxima across the edge, above an adaptive floor
  const sorted = Float32Array.from(mag).sort();
  const floor = Math.max(24, sorted[Math.floor(n * 0.9)] * 0.35);
  const T = 180, diag = Math.ceil(Math.hypot(w, h)), R = 2 * diag + 1;
  const acc = new Float32Array(T * R);
  const cos = new Float32Array(T), sin = new Float32Array(T);
  // θ spans [-45°, 135°): the wrap-around falls on diagonals, so near-vertical and near-horizontal edges —
  // the usual case for a document — never have their votes split across both ends of the range
  const theta0 = -Math.PI / 4;
  for (let t = 0; t < T; t++) (cos[t] = Math.cos(theta0 + (t * Math.PI) / T)), (sin[t] = Math.sin(theta0 + (t * Math.PI) / T));
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, m = mag[i];
      if (m < floor) continue;
      const ux = gx[i] / m, uy = gy[i] / m;
      const fx = Math.round(ux), fy = Math.round(uy);
      if (m < mag[i + fy * w + fx] || m < mag[i - fy * w - fx]) continue; // non-maximum suppression
      let phi = Math.atan2(uy, ux);
      while (phi < theta0) phi += Math.PI;
      while (phi >= theta0 + Math.PI) phi -= Math.PI;
      const tc = Math.round(((phi - theta0) * T) / Math.PI);
      // saturate early: a faint paper edge on a light floor should count about as much as a bold tile line
      const wgt = Math.min(1, m / 50);
      for (let dt = -6; dt <= 6; dt++) {
        const t = (tc + dt + T) % T;
        const rho = Math.round(x * cos[t] + y * sin[t]) + diag;
        // spread over neighbouring offsets so a slightly wavy edge (crumpled paper) still adds up to one line
        acc[t * R + rho] += wgt;
        if (rho > 0) acc[t * R + rho - 1] += wgt * 0.5;
        if (rho < R - 1) acc[t * R + rho + 1] += wgt * 0.5;
      }
    }
  // local maxima, strongest first, suppressing near-duplicates
  const peaks: Line[] = [];
  for (let t = 0; t < T; t++)
    for (let r = 1; r < R - 1; r++) {
      const v = acc[t * R + r];
      if (v < 10) continue;
      let isMax = true;
      for (let dt = -2; dt <= 2 && isMax; dt++) {
        const tt = t + dt;
        if (tt < 0 || tt >= T) continue;
        for (let dr = -2; dr <= 2; dr++) {
          const rr = r + dr;
          if ((!dt && !dr) || rr < 0 || rr >= R) continue;
          const u = acc[tt * R + rr];
          if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ theta: theta0 + (t * Math.PI) / T, rho: r - diag, votes: v });
    }
  peaks.sort((a, b) => b.votes - a.votes);
  const out: Line[] = [];
  for (const p of peaks) {
    // duplicates: lines that stay within a few pixels of each other across the whole image
    const same = (q: Line) => linesClose(p, q, w, h, Math.max(4, Math.max(w, h) * 0.015));
    if (out.some(same)) continue;
    out.push(p);
    if (out.length >= maxLines) break;
  }
  return out;
}

/** Whether two lines stay within `tol` px of each other where they cross the image. */
function linesClose(a: Line, b: Line, w: number, h: number, tol: number) {
  if (angleDiff(a.theta, b.theta) > 0.2) return false;
  // sample a along its span across the image and measure the distance to b
  const ca = Math.cos(a.theta), sa = Math.sin(a.theta), cb = Math.cos(b.theta), sb = Math.sin(b.theta);
  const vertical = Math.abs(ca) > Math.abs(sa);
  for (const t of [0, 0.5, 1]) {
    const x = vertical ? (a.rho - t * h * sa) / ca : t * w;
    const y = vertical ? t * h : (a.rho - t * w * ca) / sa;
    if (Math.abs(x * cb + y * sb - b.rho) > tol) return false;
  }
  return true;
}

function angleDiff(a: number, b: number) {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

function intersect(a: Line, b: Line): Point | null {
  const ca = Math.cos(a.theta), sa = Math.sin(a.theta), cb = Math.cos(b.theta), sb = Math.sin(b.theta);
  const d = ca * sb - sa * cb;
  if (Math.abs(d) < 1e-6) return null;
  return { x: (a.rho * sb - b.rho * sa) / d, y: (ca * b.rho - cb * a.rho) / d };
}

interface Profile {
  line: Line;
  /** Running totals of edge support of each polarity along the line, sampled every 2 px from s = -diag. */
  pos: Float32Array;
  neg: Float32Array;
  diag: number;
}

/** Edge support along a whole line, so any segment of it can be scored with two lookups. */
function profile(G: Gradients, line: Line, full = 40): Profile {
  const { w, h, gx, gy, mag } = G;
  const diag = Math.ceil(Math.hypot(w, h));
  const c = Math.cos(line.theta), sn = Math.sin(line.theta);
  const n = diag + 1; // samples at s = -diag, -diag + 2, …, diag
  const pos = new Float32Array(n + 1), neg = new Float32Array(n + 1);
  for (let k = 0; k < n; k++) {
    const sp = -diag + 2 * k;
    const px = line.rho * c - sp * sn, py = line.rho * sn + sp * c;
    let best = 0;
    for (let o = -1.5; o <= 1.5; o += 0.75) {
      const x = Math.round(px + c * o), y = Math.round(py + sn * o);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const i = y * w + x, v = gx[i] * c + gy[i] * sn;
      if (Math.abs(v) >= 0.75 * mag[i] && Math.abs(v) > Math.abs(best)) best = v;
    }
    const v = Math.min(1, Math.abs(best) / full);
    pos[k + 1] = pos[k] + (best > 0 ? v : 0);
    neg[k + 1] = neg[k] + (best < 0 ? v : 0);
  }
  return { line, pos, neg, diag };
}

/** Support (dominant polarity) of the stretch of a profiled line between points a and b, corners trimmed. */
function segmentSupport(P: Profile, a: Point, b: Point): number {
  const c = Math.cos(P.line.theta), sn = Math.sin(P.line.theta);
  let sa = -a.x * sn + a.y * c, sb = -b.x * sn + b.y * c;
  if (sa > sb) [sa, sb] = [sb, sa];
  const trim = (sb - sa) * 0.03;
  const n = P.pos.length - 1;
  const ka = Math.max(0, Math.min(n, Math.round((sa + trim + P.diag) / 2)));
  const kb = Math.max(0, Math.min(n, Math.round((sb - trim + P.diag) / 2)));
  if (kb <= ka) return 0;
  return Math.max(P.pos[kb] - P.pos[ka], P.neg[kb] - P.neg[ka]) / (kb - ka);
}

/** Quads whose four sides are each one of the strongest straight edges in the image. */
export function edgeQuads(G: Gradients, minArea: number, keep = 24): Quad[] {
  const { w, h } = G;
  const lines = houghLines(G, 24);
  // a line is "horizontal" when its normal is near vertical
  const hor = lines.filter((l) => Math.abs(l.theta - Math.PI / 2) < Math.PI / 4).slice(0, 12).map((l) => profile(G, l));
  const ver = lines.filter((l) => Math.abs(l.theta - Math.PI / 2) >= Math.PI / 4).slice(0, 12).map((l) => profile(G, l));
  const found: { q: Quad; s: number }[] = [];
  const mx = w * 0.04, my = h * 0.04;
  for (let i = 0; i < hor.length; i++)
    for (let j = i + 1; j < hor.length; j++) {
      if (angleDiff(hor[i].line.theta, hor[j].line.theta) > 0.6) continue;
      for (let k = 0; k < ver.length; k++)
        for (let l = k + 1; l < ver.length; l++) {
          if (angleDiff(ver[k].line.theta, ver[l].line.theta) > 0.6) continue;
          const pts = [
            intersect(hor[i].line, ver[k].line),
            intersect(hor[i].line, ver[l].line),
            intersect(hor[j].line, ver[l].line),
            intersect(hor[j].line, ver[k].line),
          ];
          if (pts.some((p) => !p || p.x < -mx || p.y < -my || p.x > w + mx || p.y > h + my)) continue;
          const [p0, p1, p2, p3] = pts as Point[];
          const area = Math.abs(polygonArea([p0, p1, p2, p3]));
          if (area < minArea * w * h) continue;
          // cheap first pass from the line profiles; only the promising few get the full score
          const sides = [segmentSupport(hor[i], p0, p1), segmentSupport(ver[l], p1, p2), segmentSupport(hor[j], p2, p3), segmentSupport(ver[k], p3, p0)];
          const mean = (sides[0] + sides[1] + sides[2] + sides[3]) / 4;
          found.push({ q: pts as unknown as Quad, s: mean * mean * Math.min(...sides) * Math.sqrt(area) });
        }
    }
  found.sort((a, b) => b.s - a.s);
  const out: Quad[] = [];
  for (const f of found) {
    const q = orderQuad(f.q);
    if (!isConvex(q) || quadAngles(q).some((a) => a < 45 || a > 135)) continue;
    out.push(q);
    if (out.length >= keep) break;
  }
  return out;
}

function fitLine(pts: Point[]): { p: Point; d: Point } | null {
  if (pts.length < 6) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) (sxx += (p.x - mx) ** 2), (sxy += (p.x - mx) * (p.y - my)), (syy += (p.y - my) ** 2);
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy); // principal direction (total least squares)
  return { p: { x: mx, y: my }, d: { x: Math.cos(a), y: Math.sin(a) } };
}

function lineIntersect(a: { p: Point; d: Point }, b: { p: Point; d: Point }): Point | null {
  const den = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / den;
  return { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
}

/**
 * Snaps each side of `q` onto the strongest step edge of its dominant polarity within `radius` px, fitting a
 * line through those edge points with outliers dropped. Sides without enough edge evidence stay as they are.
 */
export function refineQuad(G: Gradients, q: Quad, radius: number): Quad {
  const { w, h, gx, gy } = G;
  const lines = q.map((a, i) => {
    const b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    const signed = (x: number, y: number) => {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return 0;
      const k = yi * w + xi;
      return gx[k] * nx + gy[k] * ny;
    };
    const samples = 48;
    const found: { p: Point; v: number }[] = [];
    for (let s = 0; s < samples; s++) {
      const t = 0.08 + (0.84 * s) / (samples - 1);
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      let best = 0, bestO = 0;
      for (let o = -radius; o <= radius; o += 0.5) {
        const v = signed(px + nx * o, py + ny * o);
        if (Math.abs(v) > Math.abs(best)) (best = v), (bestO = o);
      }
      if (Math.abs(best) > 24) found.push({ p: { x: px + nx * bestO, y: py + ny * bestO }, v: best });
    }
    // keep the dominant polarity, then fit and drop outliers twice
    const sign = found.reduce((s, f) => s + f.v, 0) >= 0 ? 1 : -1;
    let pts = found.filter((f) => Math.sign(f.v) === sign).map((f) => f.p);
    if (pts.length < samples * 0.3) return null;
    let line = fitLine(pts);
    for (let pass = 0; pass < 2 && line; pass++) {
      const l = line;
      const dist = (p: Point) => Math.abs((p.x - l.p.x) * l.d.y - (p.y - l.p.y) * l.d.x);
      const sorted = pts.map(dist).sort((x, y) => x - y);
      const cut = Math.max(1, sorted[Math.floor(sorted.length * 0.7)] * 1.5);
      pts = pts.filter((p) => dist(p) <= cut);
      line = fitLine(pts);
    }
    return line;
  });
  const out = q.map((p, i) => {
    const before = lines[(i + 3) % 4], after = lines[i];
    if (!before || !after) return p;
    const x = lineIntersect(before, after);
    return x && Math.hypot(x.x - p.x, x.y - p.y) <= radius * 2 ? x : p;
  });
  return out as Quad;
}
