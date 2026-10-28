// Node check that the playground's detector code (buildInput + decodeHeatmap) matches the offline
// harness: run it on a SmartDoc frame with ground truth and compare IoU.
// Usage: vite-node verify.ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import jpeg from 'jpeg-js';
import { buildInput, decodeHeatmap } from './detector.js';
import { readMetadata } from '../test/private/eval/smartdoc-meta.js';
import { smartdocIoU } from '../test/private/eval/metrics.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ort = createRequire(join(__dirname, '../test/private/eval/ml/'))('onnxruntime-node') as any;
const dataDir = resolve(join(__dirname, '../test/private/smartdoc15'));
const modelPath = join(__dirname, 'public/lcnet100_int8.onnx');

const session = await ort.InferenceSession.create(modelPath);
const rows = readMetadata(dataDir).filter((_, i) => i % 300 === 0);
const ious: number[] = [];

for (const r of rows) {
  const img = jpeg.decode(readFileSync(join(dataDir, r.path)), { maxMemoryUsageInMB: 1024 });
  const tensor = new ort.Tensor('float32', buildInput(img as unknown as ImageData), [1, 3, 256, 256]);
  const out = await session.run({ [session.inputNames[0]]: tensor });
  const heat = out[session.outputNames[0]];
  const [, , hh, hw] = heat.dims as number[];
  const quad = decodeHeatmap(heat.data as Float32Array, hh, hw, img.width, img.height);
  if (!quad) {
    ious.push(0);
    continue;
  }
  ious.push(smartdocIoU(quad, r.gt, r.docW, r.docH));
}

const mean = ious.reduce((a, b) => a + b, 0) / ious.length;
console.log(`${rows.length} frames · mean IoU ${mean.toFixed(4)} · IoU>=0.95 ${((ious.filter((x) => x >= 0.95).length / ious.length) * 100).toFixed(1)}% · misses ${ious.filter((x) => x === 0).length}`);
if (mean < 0.9) {
  console.error('FAIL: the browser preprocessing/decode does not reproduce the offline result');
  process.exit(1);
}
console.log('OK: matches the offline harness');
