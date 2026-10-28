import { describe, expect, it } from 'vitest';
import { detectDocument, warpPerspective, enhance, createPdf } from '../src/index.js';
import type { Quad } from '../src/types.js';
import { scene, sunlitFloor } from './scene.js';

const paper: Quad = [
  { x: 170, y: 210 },
  { x: 470, y: 190 },
  { x: 500, y: 640 },
  { x: 160, y: 660 },
];

function maxCornerError(a: Quad, b: Quad) {
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
}

describe('detectDocument', () => {
  it('finds a tilted sheet on cardboard next to a white floor, with a cable across its edge', () => {
    const d = detectDocument(scene(640, 800, paper));
    expect(d).not.toBeNull();
    expect(maxCornerError(d!.corners, paper)).toBeLessThan(800 * 0.02);
    expect(d!.confidence).toBeGreaterThan(0.85);
  });

  it('separates white paper from a sunlit light floor and ignores a grout line beside it', () => {
    const d = detectDocument(sunlitFloor(600, 800, paper));
    expect(d).not.toBeNull();
    expect(maxCornerError(d!.corners, paper)).toBeLessThan(800 * 0.015);
  });

  it('returns corners in input coordinates regardless of workSize', () => {
    const d = detectDocument(scene(640, 800, paper), { workSize: 250 });
    expect(maxCornerError(d!.corners, paper)).toBeLessThan(800 * 0.03);
  });

  it('returns null when there is no paper', () => {
    const img = scene(400, 300, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], { occluder: false, floor: false });
    expect(detectDocument(img)).toBeNull();
  });
});

describe('warpPerspective + enhance', () => {
  it('flattens the sheet and whitens the paper', () => {
    const img = scene(640, 800, paper, { occluder: false });
    const flat = warpPerspective(img, paper);
    // the quad is a generic quadrilateral, so the perspective decides the width; the long side is the quad's
    expect(Math.abs(flat.width - 249) / 249).toBeLessThan(0.05);
    expect(Math.abs(flat.height - 451) / 451).toBeLessThan(0.05);
    const out = enhance(flat, 'gray');
    let white = 0;
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i] > 245) white++;
    expect(white / (out.width * out.height)).toBeGreaterThan(0.6);
  });

  it('caps the output size', () => {
    const flat = warpPerspective(scene(640, 800, paper), paper, { maxSide: 200 });
    expect(Math.max(flat.width, flat.height)).toBe(200);
  });
});

describe('createPdf', () => {
  it('writes a well-formed PDF with a correct xref', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const pdf = createPdf([{ jpeg, width: 10, height: 20 }, { jpeg, width: 20, height: 10 }]);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 2');
    const startxref = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    for (const m of text.matchAll(/^(\d{10}) 00000 n $/gm)) expect(text.slice(Number(m[1])).match(/^\d+ 0 obj/)).not.toBeNull();
  });
});
