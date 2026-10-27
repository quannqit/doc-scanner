import { convexHull, enclosingQuad, isConvex, orderQuad, polygonArea, quadAngles, scaleQuad } from './geometry.js';
import { edgeQuads, gradients, refineQuad, sideSupport } from './edges.js';
import { downscale, morph, otsu } from './image.js';
import type { DetectOptions, Detection, Point, Quad, RGBAImage } from './types.js';


/**
 * Finds a sheet of paper in an image.
 *
 * Candidates come from two independent sources:
 * - colour: bright, unsaturated regions, each reduced to its smallest enclosing quadrilateral. Copes with busy
 *   backgrounds (cardboard, wood, packaging) and with objects lying across an edge.
 * - edges: quadrilaterals built from the strongest straight edges (gradient-oriented Hough transform). Copes
 *   with white paper on a light floor or in patchy sunlight, where colour alone cannot separate them.
 *
 * Every candidate is then scored the same way — how much of each side runs along a real edge in the image,
 * times its size — and the best one wins. Quads touching the frame border are penalised.
 *
 * Returns `null` when nothing looks like a document; fall back to `defaultQuad` and let the user adjust.
 */
export function detectDocument(img: RGBAImage, opts: DetectOptions = {}): Detection | null {
  const { workSize = 400, refineSize = 1000, minArea = 0.08 } = opts;
  const { image, scale } = downscale(img, workSize);
  const { width: w, height: h } = image;

  const G = gradients(image);
  const candidates = [...colorQuads(image, minArea), ...edgeQuads(G, minArea)];
  const edge = Math.max(w, h) * 0.01;

  let best: { quad: Quad; score: number; support: number } | null = null;
  for (const quad of candidates) {
    const { sides, ends, beyond } = sideSupport(G, quad);
    const mean = (sides[0] + sides[1] + sides[2] + sides[3]) / 4, min = Math.min(...sides);
    // Corner i joins the start of side i and the end of side i-1. It should have edge right up to it on both
    // sides, and the edges should stop there: when both carry on past it, it is a crossing, not a corner.
    const corners = [0, 1, 2, 3].map((i) => {
      const into = (ends[i * 2] + ends[(i * 2 + 7) % 8]) / 2;
      const past = (beyond[i * 2] + beyond[(i * 2 + 7) % 8]) / 2;
      return into * (1 - 0.7 * past);
    });
    const corner = Math.min(...corners);
    if (mean < 0.4 || min < 0.15 || corner < 0.2) continue;
    const area = Math.abs(polygonArea(quad)) / (w * h);
    const touching = quad.some((p) => p.x <= edge || p.y <= edge || p.x >= w - edge || p.y >= h - edge);
    const score = mean * mean * min * corner * Math.sqrt(area) * (touching ? 0.6 : 1);
    if (!best || score > best.score) best = { quad, score, support: mean };
  }
  if (!best) return null;

  // The search runs at a coarse size; fit the sides to the edges at a finer one for accurate corners.
  const fine = scale < 1 ? downscale(img, refineSize) : { image, scale };
  const k = fine.scale / scale;
  const radius = Math.max(3, Math.round(Math.max(fine.image.width, fine.image.height) * 0.008));
  const refined = refineQuad(fine.image === image ? G : gradients(fine.image), scaleQuad(best.quad, k), radius);
  return { corners: scaleQuad(refined, 1 / fine.scale), confidence: best.support };
}

/** Quads around bright, unsaturated regions, at a few thresholds to cope with warm, dim or harsh light. */
function colorQuads(image: RGBAImage, minArea: number): Quad[] {
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
  const out: Quad[] = [];
  for (const vMin of [Math.max(90, Math.min(200, t)), Math.min(230, Math.round((Math.max(t, 90) + 255) / 2))])
    for (const sMax of [45, 75]) {
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = val[i] >= vMin && sat[i] <= sMax ? 1 : 0;
      out.push(...regionQuads(mask, w, h, minArea));
    }
  return out;
}

function regionQuads(raw: Uint8Array, w: number, h: number, minArea: number): Quad[] {
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
  if (!big.length) return [];

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

  const out: Quad[] = [];
  for (const id of big) {
    const pts: Point[] = [];
    const mn = rowMin.get(id)!, mx = rowMax.get(id)!;
    for (let y = 0; y < h; y++) if (mn[y] >= 0) pts.push({ x: mn[y], y }, { x: mx[y] + 1, y }, { x: mn[y], y: y + 1 }, { x: mx[y] + 1, y: y + 1 });
    const q = enclosingQuad(convexHull(pts));
    if (!q || !isConvex(q)) continue;
    const quad = orderQuad(q);
    const quadArea = Math.abs(polygonArea(quad));
    if (areas[id] / quadArea < 0.8 || quadArea > w * h * 1.02) continue;
    if (quadAngles(quad).some((a) => a < 40 || a > 140)) continue;
    // the mask was closed and the quad encloses it, so pull the corners in a touch to sit on the paper edge
    const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4, cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
    out.push(
      quad.map((p) => {
        const d = Math.hypot(p.x - cx, p.y - cy) || 1, k = Math.min(1, d * 0.1) / d;
        return { x: p.x - (p.x - cx) * k, y: p.y - (p.y - cy) * k };
      }) as Quad,
    );
  }
  return out;
}
