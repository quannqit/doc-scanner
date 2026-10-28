/** Raw RGBA pixels, row-major, 4 bytes per pixel. `ImageData` satisfies this. */
export interface RGBAImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Corners of the document in image pixels: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

export type EnhanceMode =
  /** No processing, just the flattened crop. */
  | 'original'
  /** Even out lighting and whiten the paper, keep colours (stamps, signatures). */
  | 'color'
  /** Like `color`, in grayscale. */
  | 'gray'
  /** High-contrast black and white, smallest files. */
  | 'bw';

export interface DetectOptions {
  /** Image is downscaled so its long side is at most this before detecting. Default 400. */
  workSize?: number;
  /** Corners are fitted to the edges at this size (long side) after the search. Default 1000. */
  refineSize?: number;
  /** Minimum share of the frame the document must cover, 0–1. Default 0.08. */
  minArea?: number;
}

export interface Detection {
  /** Corners in the coordinates of the image passed in. */
  corners: Quad;
  /** 0–1. How much of the quad's outline runs along real edges in the image. */
  confidence: number;
}

/**
 * Finds a document in a frame, for callers that bring their own model (an ONNX corner detector,
 * a server call, a different heuristic). Receive the full frame as a canvas, resolve corners in its
 * pixel coordinates, or `null` when there is no document.
 *
 * Both the live preview and the full-resolution capture go through this, so it must cope with
 * small frames (a few hundred pixels wide) and with photos.
 */
export type Detector = (frame: HTMLCanvasElement) => Promise<Quad | null>;
