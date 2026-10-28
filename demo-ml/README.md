# ML playground

Corner detection with a quantized ONNX model, end to end in the browser: ONNX Runtime Web (WASM)
finds the page, then the library's `warpPerspective` + `enhance` produce a flat scan.

The model is `lcnet100` (PP-LCNet-1.0 + BiFPN + heatmap head), statically quantized to int8:
**1.59 MB** instead of 4.77 MB fp32, mean IoU 0.9675 vs 0.9874 on SmartDoc (see
`../test/private/eval/preproc-eval.ts`).

```sh
npm run demo:ml          # copies the model into public/, then starts Vite on :5175
npm run demo:ml:assets   # just the copy
```

Open <http://localhost:5175/>. Add `?img=sample.jpg` to run it on the bundled photo without a camera.

## Camera

`getUserMedia` needs a secure context: `localhost` works, a LAN IP does not. To test on a phone,
put a certificate in `demo-ml/cert/` (`key.pem` + `cert.pem`, e.g. from `mkcert`) and Vite will
serve HTTPS. Without one, the page falls back to the photo picker, which uses the same detector.

## Payload

| file | raw | gzip |
|---|---:|---:|
| `lcnet100_int8.onnx` (public/) | 1.59 MB | 1.12 MB |
| `ort-wasm-simd-threaded.wasm` (built asset) | 11.2 MB | 2.83 MB |

The ORT runtime dominates. It is cached after the first load; serve it with brotli to keep the
first visit near 4 MB. Vite fingerprints it under `assets/`, so it is immutable — the service worker
in the CRM caches that path cache-first.

Keep `optimizeDeps.exclude: ['onnxruntime-web']` in the Vite config: ort resolves its `.wasm` with
`new URL(..., import.meta.url)`, which works when Vite processes the module but not when the dev
server prebundles it (the request comes back as `index.html`).

## Gotchas baked into the code

- **Stretch, never letterbox.** The model was trained on square, stretched input. Padding the image
  makes it detect the padding border (IoU 0.12 instead of 0.97).
- **Single WASM thread** (`ort.env.wasm.numThreads = 1`) so no `Cross-Origin-Opener-Policy` /
  `Cross-Origin-Embedder-Policy` headers are needed.
- **Detection on a downscaled copy** (512–900 px); the model input is 256×256 regardless, so
  feeding it more only costs time.
- **`createImageBitmap(blob, { imageOrientation: 'from-image' })`** for photo uploads, or EXIF-rotated
  phone pictures come out sideways.

## Checking it without a browser

`npm run demo:ml` needs Vite; `verify.ts` runs the same `buildInput` + `decodeHeatmap` code in Node
against SmartDoc ground truth:

```sh
node_modules/.bin/vite-node demo-ml/verify.ts
# 83 frames · mean IoU 0.9725 · IoU>=0.95 92.8% · misses 0
```
