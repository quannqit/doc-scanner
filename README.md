# @quannqit/doc-scanner

Document scanning in the browser: find a sheet of paper in a camera frame or photo, flatten its perspective,
and clean it up like a flatbed scanner. Optional full-screen React camera UI with live outline, corner
adjustment, filters and multi-page capture.

- **Zero dependencies, no OpenCV.** ~6 kB gzipped (~10 kB with the React UI) instead of an 8 MB OpenCV.js download.
- **Robust on busy backgrounds.** Paper is found by colour (bright, unsaturated) rather than by edges, so it
  works on cardboard, wood or printed packaging, and when a cable or hand covers part of an edge.
- **Scanner-style filters**: `color` (keeps red stamps and blue ink), `gray`, `bw`, `original`. Shadows and
  uneven lighting are removed.
- **PDF export** of multiple pages, no PDF library needed.
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

1. Downscale to ~400 px. Mark pixels that are bright and unsaturated; try a few thresholds (Otsu-based) to
   cope with warm or dim lighting.
2. Morphological close (bridges text and thin occluders) and open (cuts thin links to neighbouring white areas).
3. For each large region, take the convex hull and reduce it to the **smallest enclosing quadrilateral**, so a
   corner hidden under an object is restored instead of cut off.
4. Score regions by how well they fill their quad, their size, and whether they touch the frame border (a white
   floor or wall), and keep the best.

Limitation: white paper on a white table has no colour contrast to find. The UI then starts from an inset
frame and the user drags the corners.

## Demo

```sh
npm run demo   # then open the printed URL on your phone (HTTPS needed for the camera off localhost)
```

## License

MIT
