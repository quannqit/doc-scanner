import { convexHull, enclosingQuad, isConvex, orderQuad, polygonArea, quadAngles, scaleQuad } from './geometry.js';
import { downscale, morph, otsu } from './image.js';
import type { DetectOptions, Detection, Point, Quad, RGBAImage } from './types.js';

interface Candidate {
  quad: Quad;
  fill: number;
  score: number;
}

/**
 * Finds a sheet of paper in an image.
 *
 * Paper is told apart from its surroundings by colour — bright and unsaturated — rather than by edges, so it
 * holds up on busy backgrounds (cardboard, wood grain, printed packaging) and when something lies across an
 * edge. Each white region is reduced to the smallest enclosing quadrilateral, and the region that best fills
 * its quad wins. Regions touching the frame border (a white floor or wall) are penalised.
 *
 * Returns `null` when nothing looks like a document; fall back to `defaultQuad` and let the user adjust.
 */
export function detectDocument(img: RGBAImage, opts: DetectOptions = {}): Detection | null {
  const { workSize = 400, minArea = 0.08 } = opts;
  const { image, scale } = downscale(img, workSize);
  const { width: w, height: h, data } = image;
  const n = w * h;

  const val = new Uint8Array(n), sat = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    val[i] = max;
    sat[i] = max ? ((max - min) * 255) / max : 0;
    hist[max]++;
  }
  const t = otsu(hist);

  // Lighting varies a lot (warm bulbs tint paper, shadows darken it), so try a few thresholds and keep the best.
  const tries: [number, number][] = [];
  for (const v of [Math.max(90, Math.min(200, t)), Math.min(230, Math.round((Math.max(t, 90) + 255) / 2))])
    for (const s of [45, 75]) tries.push([v, s]);

  let best: Candidate | null = null;
  for (const [vMin, sMax] of tries) {
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = val[i] >= vMin && sat[i] <= sMax ? 1 : 0;
    const c = bestRegion(mask, w, h, minArea);
    if (c && (!best || c.score > best.score)) best = c;
  }
  if (!best) return null;
  // the mask is closed and the quad encloses it, so pull the corners in a touch to drop the background rim
  const q = best.quad;
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const inset = q.map((p) => {
    const d = Math.hypot(p.x - cx, p.y - cy) || 1, k = Math.min(1.5, d * 0.1) / d;
    return { x: p.x - (p.x - cx) * k, y: p.y - (p.y - cy) * k };
  }) as Quad;
  return { corners: scaleQuad(inset, 1 / scale), confidence: best.fill };
}

function bestRegion(raw: Uint8Array, w: number, h: number, minArea: number): Candidate | null {
  const long = Math.max(w, h);
  // close: bridge text, lines and thin occluders; open: cut thin bridges to neighbouring white regions
  const rc = Math.max(2, Math.round(long * 0.015)), ro = Math.max(1, Math.round(long * 0.008));
  let mask = morph(morph(raw, w, h, rc, false), w, h, rc, true);
  mask = morph(morph(mask, w, h, ro, true), w, h, ro, false);

  // label connected components (4-connectivity)
  const labels = new Int32Array(w * h);
  const areas: number[] = [0];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = areas.length;
    let sp = 0, area = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp) {
      const p = stack[--sp];
      area++;
      const x = p % w;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) (labels[p - 1] = id), (stack[sp++] = p - 1);
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) (labels[p + 1] = id), (stack[sp++] = p + 1);
      if (p >= w && mask[p - w] && !labels[p - w]) (labels[p - w] = id), (stack[sp++] = p - w);
      if (p < w * (h - 1) && mask[p + w] && !labels[p + w]) (labels[p + w] = id), (stack[sp++] = p + w);
    }
    areas.push(area);
  }

  const minPx = minArea * w * h;
  const big = areas.map((a, id) => (id && a >= minPx ? id : 0)).filter(Boolean);
  if (!big.length) return null;

  // the leftmost and rightmost pixel of each row is all the convex hull needs
  const rowMin = new Map<number, Int32Array>(), rowMax = new Map<number, Int32Array>();
  for (const id of big) rowMin.set(id, new Int32Array(h).fill(-1)), rowMax.set(id, new Int32Array(h).fill(-1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = labels[y * w + x];
      const mn = id ? rowMin.get(id) : undefined;
      if (!mn) continue;
      if (mn[y] < 0) mn[y] = x;
      rowMax.get(id)![y] = x;
    }
  }

  let best: Candidate | null = null;
  const edge = long * 0.01;
  for (const id of big) {
    const pts: Point[] = [];
    const mn = rowMin.get(id)!, mx = rowMax.get(id)!;
    for (let y = 0; y < h; y++) if (mn[y] >= 0) pts.push({ x: mn[y], y }, { x: mx[y] + 1, y }, { x: mn[y], y: y + 1 }, { x: mx[y] + 1, y: y + 1 });
    const hull = convexHull(pts);
    const q = enclosingQuad(hull);
    if (!q || !isConvex(q)) continue;
    const quad = orderQuad(q);
    const quadArea = Math.abs(polygonArea(quad));
    const fill = areas[id] / quadArea;
    if (fill < 0.8 || quadArea > w * h * 1.02) continue;
    const angles = quadAngles(quad);
    if (angles.some((a) => a < 40 || a > 140)) continue;
    const touching = quad.filter((p) => p.x <= edge || p.y <= edge || p.x >= w - edge || p.y >= h - edge).length;
    const score = fill * fill * Math.sqrt(quadArea / (w * h)) * (touching ? 0.5 : 1);
    if (!best || score > best.score) best = { quad, fill: Math.min(1, fill), score };
  }
  return best;
}
