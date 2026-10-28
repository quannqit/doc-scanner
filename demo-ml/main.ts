// Browser playground: lcnet100 (int8) corner detection + the library's warp/enhance, end to end.
import * as ort from 'onnxruntime-web';
import { buildInput, decodeHeatmap, SIZE } from './detector.js';
import { canvasPixels, canvasToBlob, enhance, pixelsToCanvas, warpPerspective } from '../src/index.js';
import type { EnhanceMode, Quad, RGBAImage } from '../src/types.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = $<HTMLCanvasElement>('stage');
const overlay = $<HTMLCanvasElement>('overlay');
const statusChip = $<HTMLElement>('status');
const timingChip = $<HTMLElement>('timing');
const hint = $<HTMLElement>('hint');
const placeholder = $<HTMLElement>('placeholder');
const camBtn = $<HTMLButtonElement>('cam');
const fileInput = $<HTMLInputElement>('file');
const scanBtn = $<HTMLButtonElement>('scan');
const modeSelect = $<HTMLSelectElement>('mode');
const result = $<HTMLElement>('result');
const flatCanvas = $<HTMLCanvasElement>('flat');
const cleanCanvas = $<HTMLCanvasElement>('clean');
const cleanLabel = $<HTMLElement>('cleanLabel');
const downloadBtn = $<HTMLButtonElement>('download');

const video = document.createElement('video');
video.muted = true;
video.playsInline = true;

let session: ort.InferenceSession | null = null;
let stream: MediaStream | null = null;
let rafId = 0;
let lastDetect = 0;
let detecting = false;
let quad: Quad | null = null;
let lastFlat: RGBAImage | null = null;

const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true })!;

/** Runs the model on `source`, downscaled so its long side is at most `maxSide`. Returns corners in source pixels. */
async function detect(source: HTMLCanvasElement, maxSide: number): Promise<{ quad: Quad | null; ms: number }> {
  if (!session) return { quad: null, ms: 0 };
  const k = Math.min(1, maxSide / Math.max(source.width, source.height));
  work.width = Math.max(1, Math.round(source.width * k));
  work.height = Math.max(1, Math.round(source.height * k));
  workCtx.drawImage(source, 0, 0, work.width, work.height);
  const pixels = workCtx.getImageData(0, 0, work.width, work.height);

  const t0 = performance.now();
  const tensor = new ort.Tensor('float32', buildInput(pixels), [1, 3, SIZE, SIZE]);
  const out = await session.run({ [session.inputNames[0]]: tensor });
  const heat = out[session.outputNames[0]];
  const [, , hh, hw] = heat.dims as number[];
  const found = decodeHeatmap(heat.data as Float32Array, hh, hw, work.width, work.height);
  const ms = performance.now() - t0;

  if (!found) return { quad: null, ms };
  const sx = source.width / work.width, sy = source.height / work.height;
  return { quad: found.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad, ms };
}

function drawOverlay(q: Quad | null) {
  overlay.width = stage.width;
  overlay.height = stage.height;
  if (!q) return;
  const ctx = overlay.getContext('2d')!;
  ctx.lineWidth = Math.max(3, stage.width / 240);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#34d399';
  ctx.beginPath();
  q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  const r = Math.max(4, stage.width / 140);
  ctx.fillStyle = '#34d399';
  for (const p of q) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function setQuad(q: Quad | null, ms?: number) {
  quad = q;
  drawOverlay(q);
  scanBtn.disabled = !q;
  if (ms !== undefined) timingChip.textContent = `detect ${Math.max(1, Math.round(ms))} ms`;
  hint.textContent = q
    ? 'Outline found. Press Scan, or move closer.'
    : 'No document found — keep the whole page in frame, with a margin around it.';
}

function showPlaceholder(text: string) {
  placeholder.textContent = text;
  placeholder.style.display = 'grid';
  stage.width = 640;
  stage.height = 420;
  overlay.width = 640;
  overlay.height = 420;
}

async function loadModel() {
  ort.env.wasm.numThreads = 1; // no COOP/COEP headers needed
  const t0 = performance.now();
  session = await ort.InferenceSession.create(`${import.meta.env.BASE_URL}lcnet100_int8.onnx`, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  statusChip.textContent = `model 1.6 MB · ready in ${Math.round(performance.now() - t0)} ms`;
  statusChip.classList.add('ok');
}

function loop() {
  if (!stream) return;
  if (video.readyState >= 2) {
    if (stage.width !== video.videoWidth) {
      stage.width = video.videoWidth;
      stage.height = video.videoHeight;
    }
    stage.getContext('2d')!.drawImage(video, 0, 0, stage.width, stage.height);
    if (!detecting && performance.now() - lastDetect > 350) {
      lastDetect = performance.now();
      detecting = true;
      detect(stage, 512)
        .then(({ quad: q, ms }) => setQuad(q, ms))
        .catch(() => {})
        .finally(() => (detecting = false));
    }
  }
  rafId = requestAnimationFrame(loop);
}

async function startCamera() {
  if (stream) {
    cancelAnimationFrame(rafId);
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    camBtn.textContent = 'Camera';
    setQuad(null);
    showPlaceholder('Open the camera or pick a photo');
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    hint.textContent = 'The camera needs HTTPS or localhost. Use “Photo” instead — detection is the same.';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    camBtn.textContent = 'Stop';
    placeholder.style.display = 'none';
    loop();
  } catch (e) {
    hint.textContent = `Camera unavailable: ${(e as Error).message}`;
  }
}

function renderResult() {
  if (!lastFlat) return;
  pixelsToCanvas(lastFlat, flatCanvas);
  const mode = modeSelect.value as EnhanceMode;
  pixelsToCanvas(enhance(lastFlat, mode), cleanCanvas);
  cleanLabel.textContent = `enhanced · ${mode}`;
  result.classList.add('on');
}

async function scan() {
  if (!session || !stage.width) return;
  scanBtn.disabled = true;
  const { quad: q } = await detect(stage, 1024);
  if (!q) {
    setQuad(null);
    scanBtn.disabled = false;
    return;
  }
  setQuad(q);
  lastFlat = warpPerspective(canvasPixels(stage), q, { maxSide: 2000 });
  renderResult();
  hint.textContent = 'Scanned. Switch the filter, download the JPEG, or pick another page.';
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  scanBtn.disabled = false;
}

camBtn.addEventListener('click', () => void startCamera());
scanBtn.addEventListener('click', () => void scan());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  await loadPhoto(file);
});

/** Draws a photo on the stage, detects, and scans it. */
async function loadPhoto(blob: Blob) {
  if (stream) await startCamera(); // stop the camera first
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  stage.width = bmp.width;
  stage.height = bmp.height;
  stage.getContext('2d')!.drawImage(bmp, 0, 0);
  placeholder.style.display = 'none';
  const { quad: q, ms } = await detect(stage, 900);
  setQuad(q, ms);
  if (q) await scan();
}

modeSelect.addEventListener('change', renderResult);

downloadBtn.addEventListener('click', async () => {
  const blob = await canvasToBlob(cleanCanvas, 'image/jpeg', 0.9);
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `scan-${Date.now()}.jpg` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

showPlaceholder('Loading model…');
(async () => {
  try {
    await loadModel();
  } catch (e) {
    statusChip.textContent = `model failed: ${(e as Error).message}`;
    statusChip.classList.add('err');
    return;
  }
  showPlaceholder('Open the camera or pick a photo');
  // `?img=sample.jpg` loads a photo straight away (handy for trying it without a camera).
  const src = new URLSearchParams(location.search).get('img');
  if (src) {
    try {
      await loadPhoto(await (await fetch(src)).blob());
    } catch (e) {
      hint.textContent = `Could not load ${src}: ${(e as Error).message}`;
    }
  }
})();
