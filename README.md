# @quannqit/doc-scanner

Document scanning in the browser: find a sheet of paper in a camera frame or photo, flatten its perspective,
and clean it up like a flatbed scanner. Optional full-screen React camera UI with live outline, corner
adjustment, filters and multi-page capture.

- **Zero dependencies, no OpenCV.** ~6 kB gzipped (~10 kB with the React UI) instead of an 8 MB OpenCV.js download.
- **Robust in real conditions.** Combines colour and edge evidence: works on cardboard, wood or printed
  packaging, on light floors and in patchy sunlight, next to tile lines, and when a cable covers part of an edge.
- **Scanner-style filters**: `color` (keeps red stamps and blue ink), `gray`, `bw`, `original`. Shadows and
  uneven lighting are removed.
- **True proportions.** The output size comes from the quad's perspective, not from its edge lengths, so a
  page shot at an angle comes out A4-shaped instead of its foreshortened silhouette.
- **PDF export** of multiple pages, no PDF library needed.
- Zoom buttons and pinch-to-zoom (camera zoom where available, digital otherwise).
- Switch between a phone's rear cameras (main, ultra-wide, telephoto, macro); the choice is remembered.
- Works without the camera API too (plain HTTP, denied permission): falls back to the device photo picker.

```sh
npm i @quannqit/doc-scanner
```

## React

```tsx
import { useState } from 'react';
import { DocumentScanner, viLabels } from '@quannqit/doc-scanner/react';

function ScanButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Scan document</button>
      {open && (
        <DocumentScanner
          labels={viLabels} // optional; English by default
          onCancel={() => setOpen(false)}
          onDone={(pages) => {
            onFiles(pages.map((p) => p.file)); // one JPEG File per page
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
```

| Prop | Default | |
| --- | --- | --- |
| `onDone(pages)` | — | `pages[i]` has `file` (JPEG `File`), `canvas`, `width`, `height`, `mode` |
| `onCancel()` | — | Close button |
| `multiple` | `true` | Offer "Add page" |
| `defaultMode` | `'color'` | Filter preselected for each page |
| `modes` | all four | Filters offered, in order |
| `maxSide` | `2480` | Long side of each page in px (A4 at 300 dpi) |
| `quality` | `0.88` | JPEG quality |
| `fileName(i)` | `scan-YYYYMMDD-HHmmss-N.jpg` | |
| `labels` | `enLabels` | Any subset of `ScannerLabels`; `viLabels` ships for Vietnamese |
| `zIndex` | very high | |
| `maxDigitalZoom` | `3` | Zoom limit when the camera has no zoom of its own; `1` hides zoom there |
| `detector` | built-in | Finds the corners instead of `detectDocument` — see below |

**Bring your own detector.** `detector` replaces the built-in corner finder with anything that returns four
corners — a quantized ONNX model, a server call, a different heuristic. It is called for the live preview
(small frames, several times a second) and once at full resolution on capture:

```tsx
<DocumentScanner detector={myDetector} onDone={...} onCancel={...} />
```

```ts
import type { Detector } from '@quannqit/doc-scanner';

const myDetector: Detector = async (frame) => {
  // frame: HTMLCanvasElement with the camera frame or the picked photo
  // resolve corners in its pixel coordinates, or null
  return null;
};
```

Keep it fast — the preview calls it repeatedly. The component skips frames while a call is in flight, and
falls back to the built-in detector if yours throws; `null` just leaves the outline empty for the user to
place by hand. `demo-ml/` in the repository is a working example: PP-LCNet + heatmap head, int8, 1.6 MB,
~0.97 IoU on SmartDoc.

**Rear cameras.** Many phones have several rear cameras, and the browser's default pick is not always the
main one (an ultra-wide lens may not focus up close). When there is more than one, a button in the top bar
(showing e.g. "1/3") cycles through them, with a short note naming the active camera. The choice is stored in
`localStorage` (`doc-scanner:camera`) and reused next time; if that camera is gone, the default is used.

**Zoom.** The camera screen has 1×/2×/3× buttons (like the built-in camera app) and pinch-to-zoom. Where the
browser exposes the camera's own zoom (Chrome on Android) that is used, including ultra-wide 0.5× when the phone
offers it. Elsewhere (iPhone Safari, desktops) zoom is digital: the preview and the captured photo are cropped to
the centre, which helps framing but does not add detail — moving the phone closer gives a sharper scan.

The camera needs a secure context (HTTPS or `localhost`).

Combine pages into one PDF:

```ts
import { toPdf } from '@quannqit/doc-scanner';
const pdf = await toPdf(pages.map((p) => p.canvas)); // Blob, A4 pages
```

## Without React

```ts
import { scanImage, canvasToBlob } from '@quannqit/doc-scanner';

const { canvas, detected } = await scanImage(fileFromInput, { mode: 'color' });
const jpeg = await canvasToBlob(canvas);
```

Lower-level pieces work on any `{ data, width, height }` RGBA buffer (`ImageData`, decoded JPEGs in Node, …):

```ts
import { detectDocument, warpPerspective, enhance, defaultQuad } from '@quannqit/doc-scanner';

const found = detectDocument(imageData);          // { corners, confidence } | null
const corners = found?.corners ?? defaultQuad(imageData.width, imageData.height);
const flat = warpPerspective(imageData, corners); // perspective-corrected crop
const clean = enhance(flat, 'bw');                // 'color' | 'gray' | 'bw' | 'original'
```

`createPdf(pages)` builds a PDF from JPEG bytes when you are not in a browser.

## How detection works

Two independent ways of proposing a document outline, one way of judging them:

1. **Colour candidates.** Bright, unsaturated regions (a few Otsu-based thresholds for warm, dim or harsh
   light), closed and opened morphologically, each reduced to its **smallest enclosing quadrilateral** — so a
   corner hidden under a cable or hand is restored rather than cut off.
2. **Edge candidates.** The strongest straight edges from a gradient-oriented Hough transform, combined into
   quadrilaterals. This is what finds white paper on a light floor or in patchy sunlight, where colour alone
   cannot separate paper from background.
3. **Scoring.** Every candidate is judged by how much of its outline runs along real edges, with checks that
   reflect what a sheet's border looks like:
   - a **step** edge with one polarity all the way round (paper on one side, background on the other) — not a
     thin line such as grout, a tile joint or a printed frame, and not edges of mixed sign such as a cable;
   - **L-shaped corners** where both edges stop — a light or shadow boundary crossing the sheet continues past
     the sheet's edges, making T-junctions;
   - bigger is better; touching the frame border is penalised.
4. **Refinement.** The winner's sides are re-fitted to edge points at a finer resolution, for accurate corners.

Detection takes ~20 ms on a 360 px frame on a laptop, so the live preview runs it several times a second.

Limitation: when the sheet's edge has no visible contrast at all (white paper on an equally white, evenly lit
table), nothing can be found; the UI then starts from an inset frame and the user drags the corners.

## Demo

```sh
npm run demo   # then open the printed URL on your phone (HTTPS needed for the camera off localhost)
```

## License

MIT
