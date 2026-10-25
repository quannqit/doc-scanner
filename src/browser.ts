import { detectDocument } from './detect.js';
import { enhance } from './enhance.js';
import { defaultQuad } from './geometry.js';
import { createPdf, type PdfOptions } from './pdf.js';
import type { EnhanceMode, Quad, RGBAImage } from './types.js';
import { warpPerspective } from './warp.js';

export type ImageInput = Blob | string | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | ImageBitmap;

/**
 * Draws any image-like input onto a new canvas, downscaled so its long side is at most `maxSide`.
 * Keeps memory in check for 48 MP phone photos and stays under iOS Safari's canvas size limit.
 */
export async function toCanvas(input: ImageInput, maxSide = 4096): Promise<HTMLCanvasElement> {
  let src: CanvasImageSource;
  let w: number, h: number;
  if (typeof input === 'string' || input instanceof Blob) {
    const blob = typeof input === 'string' ? await (await fetch(input)).blob() : input;
    // createImageBitmap applies the EXIF orientation of phone photos
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    (src = bmp), (w = bmp.width), (h = bmp.height);
  } else if (input instanceof HTMLVideoElement) {
    (src = input), (w = input.videoWidth), (h = input.videoHeight);
  } else if (input instanceof HTMLImageElement) {
    if (!input.complete) await input.decode();
    (src = input), (w = input.naturalWidth), (h = input.naturalHeight);
  } else {
    (src = input), (w = input.width), (h = input.height);
  }
  const k = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
  if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap && src !== input) src.close();
  return canvas;
}

export function canvasPixels(canvas: HTMLCanvasElement): ImageData {
  return canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
}

export function pixelsToCanvas(img: RGBAImage, canvas = document.createElement('canvas')): HTMLCanvasElement {
  canvas.width = img.width;
  canvas.height = img.height;
  const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length);
  canvas.getContext('2d')!.putImageData(new ImageData(data, img.width, img.height), 0, 0);
  return canvas;
}

/** Detects the document on a canvas (scaled down internally) and returns corners in canvas pixels. */
export function detectOnCanvas(canvas: HTMLCanvasElement, workSize = 400) {
  const k = Math.min(1, (workSize * 2) / Math.max(canvas.width, canvas.height));
  // let the GPU do most of the downscaling before reading pixels back
  const small = document.createElement('canvas');
  small.width = Math.round(canvas.width * k);
  small.height = Math.round(canvas.height * k);
  small.getContext('2d')!.drawImage(canvas, 0, 0, small.width, small.height);
  const d = detectDocument(canvasPixels(small), { workSize });
  if (!d) return null;
  return { ...d, corners: d.corners.map((p) => ({ x: p.x / k, y: p.y / k })) as Quad };
}

export interface ScanOptions {
  /** Corners to use instead of detecting them. */
  corners?: Quad;
  mode?: EnhanceMode;
  /** Long side of the result. Default 2480. */
  maxSide?: number;
}

export interface ScanResult {
  canvas: HTMLCanvasElement;
  corners: Quad;
  /** False when nothing was detected and an inset default crop was used. */
  detected: boolean;
}

/** One call: detect, flatten and clean up a photo of a document. */
export async function scanImage(input: ImageInput, opts: ScanOptions = {}): Promise<ScanResult> {
  const source = await toCanvas(input);
  let corners = opts.corners;
  let detected = !!corners;
  if (!corners) {
    const d = detectOnCanvas(source);
    detected = !!d;
    corners = d ? d.corners : defaultQuad(source.width, source.height);
  }
  const flat = warpPerspective(canvasPixels(source), corners, { maxSide: opts.maxSide });
  return { canvas: pixelsToCanvas(enhance(flat, opts.mode ?? 'color')), corners, detected };
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.88): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality),
  );
}

/** Combines canvases (or JPEG blobs) into one PDF, one per page. */
export async function toPdf(pages: (HTMLCanvasElement | Blob)[], opts?: PdfOptions & { quality?: number }): Promise<Blob> {
  const items = await Promise.all(
    pages.map(async (p) => {
      const canvas = p instanceof Blob ? await toCanvas(p, 10000) : p;
      const blob = p instanceof Blob && p.type === 'image/jpeg' ? p : await canvasToBlob(canvas, 'image/jpeg', opts?.quality);
      return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
    }),
  );
  return new Blob([createPdf(items, opts)], { type: 'application/pdf' });
}
