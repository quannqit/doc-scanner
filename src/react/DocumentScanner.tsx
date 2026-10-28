import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { canvasPixels, canvasToBlob, detectOnCanvas, pixelsToCanvas, toCanvas } from '../browser.js';
import { detectDocument } from '../detect.js';
import { enhance } from '../enhance.js';
import { defaultQuad } from '../geometry.js';
import type { Detector, EnhanceMode, Quad, RGBAImage } from '../types.js';
import { warpPerspective } from '../warp.js';
import { enLabels, type ScannerLabels } from './labels.js';

export interface ScannedPage {
  /** JPEG of the cleaned-up page. */
  file: File;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  mode: EnhanceMode;
}

export interface DocumentScannerProps {
  /** Called with every page once the user taps Done. */
  onDone: (pages: ScannedPage[]) => void;
  onCancel: () => void;
  /** Allow scanning several pages in one go. Default true. */
  multiple?: boolean;
  /** Filter selected for each new page. Default `color`. */
  defaultMode?: EnhanceMode;
  /** Filters offered, in order. */
  modes?: EnhanceMode[];
  /** Long side of each output page in pixels. Default 2480 (A4 at 300 dpi). */
  maxSide?: number;
  /** JPEG quality 0–1. Default 0.88. */
  quality?: number;
  fileName?: (index: number) => string;
  labels?: Partial<ScannerLabels>;
  zIndex?: number;
  /**
   * Highest digital zoom offered when the camera has no zoom of its own (iPhone Safari, most desktops).
   * Digital zoom crops the frame, so it trades resolution for framing. Default 3; 1 hides zoom there.
   */
  maxDigitalZoom?: number;
  /**
   * Finds the document instead of the built-in detector — for example an ONNX corner model. Called for
   * the live preview (small frames, several times a second) and once at full resolution on capture.
   * Return `null` to let the user place the corners by hand.
   */
  detector?: Detector;
}

type Stage =
  | { kind: 'camera' }
  | { kind: 'adjust'; source: HTMLCanvasElement; corners: Quad }
  | { kind: 'review'; source: HTMLCanvasElement; corners: Quad; flat: RGBAImage };

const LIVE_SIZE = 360;
const CAMERA_KEY = 'doc-scanner:camera';
/** Zoom is remembered per camera: 2× on a main camera means something else than on a telephoto. */
const zoomKey = (cameraId: string | null | undefined) => `doc-scanner:zoom:${cameraId || 'default'}`;
const readZoom = (cameraId: string | null | undefined) => {
  try {
    const z = Number(localStorage.getItem(zoomKey(cameraId)));
    return Number.isFinite(z) && z > 0 ? z : null;
  } catch {
    return null;
  }
};

/**
 * The rear cameras, in the browser's order (Android lists the main camera first). Labels look like
 * "camera2 0, facing back" (Android) or "Back Ultra Wide Camera" (iPhone). When labels say nothing about the
 * direction, every camera except obvious front ones is offered, plus whichever one is active.
 */
function rearCameras(all: MediaDeviceInfo[], activeId?: string) {
  const front = /front|user|selfie|facetime|trước/i, back = /back|rear|environment|sau/i;
  let list = all.filter((d) => back.test(d.label));
  if (!list.length) list = all.filter((d) => !front.test(d.label) || d.deviceId === activeId);
  return list.map((d) => ({ id: d.deviceId, label: d.label.replace(/,?\s*facing back/i, '').trim() }));
}
const ACCENT = '#2ecc71';

function stamp() {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** True when the outline runs into the frame edge, so part of the sheet is out of shot. */
function touchesFrame(q: Quad, dims: { w: number; h: number } | null) {
  if (!dims) return false;
  const ex = dims.w * 0.015, ey = dims.h * 0.015;
  return q.some((p) => p.x < ex || p.y < ey || p.x > dims.w - ex || p.y > dims.h - ey);
}

/** Largest w×h box with the given aspect ratio that fits in the element. */
function useFit(aspect: number | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || !aspect) return;
    const update = () => {
      const cs = getComputedStyle(el);
      const W = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const H = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (W <= 0 || H <= 0) return;
      setBox(W / H > aspect ? { width: H * aspect, height: H } : { width: W, height: W / aspect });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);
  return { ref, box };
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/**
 * Full-screen document scanner: live camera with document outline, corner adjustment with a magnifier,
 * filters (color / grayscale / B&W / original) and multi-page capture. Falls back to the device's photo
 * picker when the camera API is unavailable (plain HTTP, denied permission, old browsers).
 */
export function DocumentScanner({
  onDone,
  onCancel,
  multiple = true,
  defaultMode = 'color',
  modes = ['color', 'gray', 'bw', 'original'],
  maxSide = 2480,
  quality = 0.88,
  fileName = (i) => `scan-${stamp()}-${i + 1}.jpg`,
  labels: labelOverrides,
  zIndex = 2147483000,
  maxDigitalZoom = 3,
  detector,
}: DocumentScannerProps) {
  const L = { ...enLabels, ...labelOverrides, modes: { ...enLabels.modes, ...labelOverrides?.modes } };
  const [stage, setStage] = useState<Stage>({ kind: 'camera' });
  const [pages, setPages] = useState<ScannedPage[]>([]);
  const [mode, setMode] = useState<EnhanceMode>(defaultMode);
  const [busy, setBusy] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const onCameraError = useCallback(() => setCameraError(true), []);

  // lock page scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => void (document.body.style.overflow = prev);
  }, []);

  /** Corner detection for a captured frame: the caller's detector when given, the built-in one otherwise. */
  const findCorners = useCallback(async (source: HTMLCanvasElement): Promise<Quad | null> => {
    if (detector) {
      try {
        return await detector(source);
      } catch {
        // a broken model must not block scanning — fall back rather than trap the user
      }
    }
    return detectOnCanvas(source)?.corners ?? null;
  }, [detector]);

  const toAdjust = useCallback(async (source: HTMLCanvasElement, hint?: Quad | null) => {
    setBusy(true);
    await nextFrame();
    const corners = (await findCorners(source)) ?? hint ?? defaultQuad(source.width, source.height);
    setStage({ kind: 'adjust', source, corners });
    setBusy(false);
  }, [findCorners]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true);
    try {
      await toAdjust(await toCanvas(f));
    } finally {
      setBusy(false);
    }
  };

  const crop = async (source: HTMLCanvasElement, corners: Quad) => {
    setBusy(true);
    await nextFrame();
    const flat = warpPerspective(canvasPixels(source), corners, { maxSide });
    setStage({ kind: 'review', source, corners, flat });
    setBusy(false);
  };

  const keep = async (canvas: HTMLCanvasElement, finish: boolean) => {
    setBusy(true);
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    const page: ScannedPage = {
      file: new File([blob], fileName(pages.length), { type: 'image/jpeg' }),
      canvas,
      width: canvas.width,
      height: canvas.height,
      mode,
    };
    const all = [...pages, page];
    setPages(all);
    setBusy(false);
    if (finish) onDone(all);
    else setStage({ kind: 'camera' });
  };

  const root: CSSProperties = {
    position: 'fixed', inset: 0, zIndex, background: '#000', color: '#fff', display: 'flex', flexDirection: 'column',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', fontSize: 15, userSelect: 'none',
    WebkitUserSelect: 'none', touchAction: 'none',
  };

  // portal to <body> so a transformed or overflow-hidden ancestor cannot trap the full-screen overlay
  return createPortal(
    <div style={root} role="dialog" aria-modal="true">
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={onFile} />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />

      {stage.kind === 'camera' && (
        <CameraStage
          labels={L}
          pages={pages.length}
          maxDigitalZoom={maxDigitalZoom}
          cameraError={cameraError}
          onCameraError={onCameraError}
          onClose={onCancel}
          onCapture={toAdjust}
          onPick={() => fileInput.current?.click()}
          onNativeCamera={() => cameraInput.current?.click()}
          onDone={() => onDone(pages)}
          detector={detector}
        />
      )}
      {stage.kind === 'adjust' && (
        <AdjustStage
          labels={L}
          source={stage.source}
          initial={stage.corners}
          onBack={() => setStage({ kind: 'camera' })}
          onCrop={(c) => crop(stage.source, c)}
        />
      )}
      {stage.kind === 'review' && (
        <ReviewStage
          labels={L}
          flat={stage.flat}
          mode={mode}
          modes={modes}
          onMode={setMode}
          multiple={multiple}
          onEditCrop={() => setStage({ kind: 'adjust', source: stage.source, corners: stage.corners })}
          onKeep={keep}
        />
      )}
      {busy && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center' }}>
          {L.processing}
        </div>
      )}
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------- camera */

function CameraStage(props: {
  labels: ScannerLabels;
  pages: number;
  maxDigitalZoom: number;
  cameraError: boolean;
  onCameraError: () => void;
  onClose: () => void;
  onCapture: (source: HTMLCanvasElement, hint: Quad | null) => void;
  onPick: () => void;
  onNativeCamera: () => void;
  onDone: () => void;
  detector?: Detector;
}) {
  const { labels: L, pages, cameraError, onCameraError, maxDigitalZoom, detector } = props;
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<MediaStreamTrack | null>(null);
  const live = useRef<Quad | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null);
  // zoom: `hw` uses the camera's own zoom; otherwise the centre of the frame is cropped (digital zoom)
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; hw: boolean } | null>(null);
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const zoomBusy = useRef<number | null>(null);
  const pinch = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null);
  const { ref: area, box } = useFit(dims ? dims.w / dims.h : null);
  // phones often have several rear cameras (main, ultra-wide, telephoto, macro); let the user pick and remember it
  const [cameras, setCameras] = useState<{ id: string; label: string }[]>([]);
  const [cameraId, setCameraId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CAMERA_KEY);
    } catch {
      return null;
    }
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const switchCamera = () => {
    if (cameras.length < 2) return;
    const i = cameras.findIndex((c) => c.id === activeId);
    const next = cameras[(i + 1) % cameras.length];
    try {
      localStorage.setItem(CAMERA_KEY, next.id);
    } catch {
      /* private mode: just don't remember */
    }
    switched.current = true;
    setCameraId(next.id);
  };

  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current || !activeId) return;
    const i = cameras.findIndex((c) => c.id === activeId);
    if (i >= 0) setToast(`${L.camera} ${i + 1}/${cameras.length}${cameras[i].label ? ' · ' + cameras[i].label : ''}`);
  }, [activeId, cameras]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  /** Crop of the video frame shown at the current digital zoom (the whole frame for camera zoom). */
  const viewCrop = (w: number, h: number) => {
    const z = zoomRange && !zoomRange.hw ? zoomRef.current : 1;
    const cw = w / z, ch = h / z;
    return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
  };

  const setZoom = (z: number) => {
    if (!zoomRange) return;
    z = Math.round(Math.min(zoomRange.max, Math.max(zoomRange.min, z)) * 100) / 100;
    if (z === zoomRef.current) return;
    zoomRef.current = z;
    setZoomState(z);
    live.current = null;
    setQuad(null);
    try {
      localStorage.setItem(zoomKey(activeIdRef.current), String(z));
    } catch {
      /* private mode: just don't remember */
    }
    if (!zoomRange.hw || !track.current) return;
    // pinching fires faster than the camera can follow: apply the latest value once the previous one is done
    if (zoomBusy.current !== null) return void (zoomBusy.current = z);
    zoomBusy.current = z;
    const apply = async (t: MediaStreamTrack) => {
      while (zoomBusy.current !== null) {
        const target = zoomBusy.current;
        try {
          await t.applyConstraints({ advanced: [{ zoom: target } as MediaTrackConstraintSet] });
        } catch {
          /* keep the previous zoom */
        }
        if (zoomBusy.current === target) zoomBusy.current = null;
      }
    };
    apply(track.current);
  };

  const onPointer = (e: RPointerEvent) => {
    const pts = pinch.current;
    if (e.type === 'pointerdown') pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    else if (e.type === 'pointermove' && pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    else pts.delete(e.pointerId);
    if (pts.size !== 2) return void (pinchStart.current = null);
    const [a, b] = [...pts.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (!pinchStart.current) pinchStart.current = { dist, zoom: zoomRef.current };
    else setZoom(pinchStart.current.zoom * (dist / pinchStart.current.dist));
  };

  useEffect(() => {
    if (cameraError) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    // fresh state for the (possibly different) camera
    setDims(null);
    setQuad(null);
    setTorch(null);
    setZoomRange(null);
    setZoomState(1);
    zoomRef.current = 1;
    live.current = null;
    (async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
        const size = { width: { ideal: 3840 }, height: { ideal: 2160 } };
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: cameraId ? { deviceId: { exact: cameraId }, ...size } : { facingMode: { ideal: 'environment' }, ...size },
          });
        } catch (e) {
          if (!cameraId) throw e;
          // the remembered camera is gone (another phone, browser reset): forget it and use the default
          try {
            localStorage.removeItem(CAMERA_KEY);
          } catch {
            /* ignore */
          }
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, ...size } });
        }
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        track.current = stream.getVideoTracks()[0];
        const settings = track.current.getSettings() as MediaTrackSettings & { zoom?: number };
        setActiveId(settings.deviceId ?? null);
        activeIdRef.current = settings.deviceId ?? null;
        const saved = readZoom(activeIdRef.current);
        const caps = (track.current.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
          torch?: boolean;
          zoom?: { min: number; max: number };
        };
        if (caps.torch) setTorch(false);
        if (caps.zoom && caps.zoom.max > caps.zoom.min) {
          let current = settings.zoom ?? caps.zoom.min;
          if (saved !== null) {
            const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, saved));
            try {
              await track.current.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] });
              current = z;
            } catch {
              /* keep the camera's own zoom */
            }
          }
          zoomRef.current = current;
          setZoomState(current);
          setZoomRange({ min: caps.zoom.min, max: caps.zoom.max, hw: true });
        } else if (maxDigitalZoom > 1) {
          const z = saved !== null ? Math.min(maxDigitalZoom, Math.max(1, saved)) : 1;
          zoomRef.current = z;
          setZoomState(z);
          setZoomRange({ min: 1, max: maxDigitalZoom, hw: false });
        }
        setDims({ w: v.videoWidth, h: v.videoHeight });
        // camera names are only readable once permission is granted, so list them now
        const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
        if (!stopped) setCameras(rearCameras(all, settings.deviceId));
      } catch {
        if (!stopped) onCameraError();
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      track.current = null;
    };
  }, [cameraError, onCameraError, maxDigitalZoom, cameraId]);

  // live detection on a small frame, ~8 times a second
  useEffect(() => {
    if (!dims) return;
    const small = document.createElement('canvas');
    // the digital-zoom crop keeps the frame's proportions, so one small canvas fits every zoom level
    const k = LIVE_SIZE / Math.max(dims.w, dims.h);
    small.width = Math.round(dims.w * k);
    small.height = Math.round(dims.h * k);
    const ctx = small.getContext('2d', { willReadFrequently: true })!;
    let misses = 0, raf = 0, last = 0, gap = 120, busy = false, cancelled = false;
    const apply = (corners: Quad | null, started: number, kc: number, crop: { x: number; y: number }) => {
      // keep the main thread mostly free on slower phones: detect at most ~1/3 of the time
      gap = Math.max(120, (performance.now() - started) * 3);
      if (!corners) {
        if (++misses > 3) (live.current = null), setQuad(null);
        return;
      }
      misses = 0;
      const next = corners.map((p) => ({ x: p.x / kc + crop.x, y: p.y / kc + crop.y })) as Quad;
      const prev = live.current;
      const jump = prev ? Math.max(...next.map((p, i) => Math.hypot(p.x - prev[i].x, p.y - prev[i].y))) : Infinity;
      // smooth small jitter, follow big moves immediately
      live.current = prev && jump < Math.max(dims.w, dims.h) * 0.06
        ? (next.map((p, i) => ({ x: prev[i].x * 0.5 + p.x * 0.5, y: prev[i].y * 0.5 + p.y * 0.5 })) as Quad)
        : next;
      setQuad(live.current);
    };
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const v = video.current;
      if (busy || !v || t - last < gap || v.readyState < 2) return;
      last = t;
      const crop = viewCrop(dims.w, dims.h);
      ctx.drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, small.width, small.height);
      const kc = small.width / crop.w;
      const started = performance.now();
      if (detector) {
        // a model runs asynchronously: never start a second one while this frame is still being read
        busy = true;
        detector(small)
          .then((q) => !cancelled && apply(q, started, kc, crop))
          .catch(() => !cancelled && apply(null, started, kc, crop))
          .finally(() => (busy = false));
        return;
      }
      const d = detectDocument(ctx.getImageData(0, 0, small.width, small.height), { workSize: LIVE_SIZE });
      apply(d?.corners ?? null, started, kc, crop);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [dims, detector]); // eslint-disable-line react-hooks/exhaustive-deps -- viewCrop reads refs

  const capture = async () => {
    const v = video.current;
    if (!v || !dims) return;
    let source: HTMLCanvasElement | null = null;
    // Chrome on Android can take a full-resolution still, much sharper than a video frame
    const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
    if (IC && track.current) {
      try {
        source = await toCanvas(await new IC(track.current).takePhoto());
      } catch {
        source = null;
      }
    }
    if (!source) source = await toCanvas(v);
    const sx = source.width / dims.w, sy = source.height / dims.h;
    const crop = viewCrop(dims.w, dims.h);
    if (crop.w < dims.w) {
      // digital zoom: keep only what the user saw
      const c = document.createElement('canvas');
      c.width = Math.round(crop.w * sx);
      c.height = Math.round(crop.h * sy);
      c.getContext('2d')!.drawImage(source, crop.x * sx, crop.y * sy, c.width, c.height, 0, 0, c.width, c.height);
      source = c;
    }
    const hint = live.current
      ? (live.current.map((p) => ({ x: (p.x - crop.x) * sx, y: (p.y - crop.y) * sy })) as Quad)
      : null;
    props.onCapture(source, hint);
  };

  const toggleTorch = async () => {
    if (!track.current || torch === null) return;
    try {
      await track.current.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  };

  return (
    <>
      <TopBar>
        <IconButton label={L.close} onClick={props.onClose}>✕</IconButton>
        <span style={{ opacity: 0.85 }}>{pages > 0 ? L.pages(pages) : ''}</span>
        <span style={{ display: 'flex', gap: 8, minWidth: 44, justifyContent: 'flex-end' }}>
          {cameras.length > 1 && (
            <IconButton label={L.switchCamera} onClick={switchCamera}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>
                {Math.max(1, cameras.findIndex((c) => c.id === activeId) + 1)}/{cameras.length}
              </span>
            </IconButton>
          )}
          {torch !== null && <IconButton label={L.torch} onClick={toggleTorch} active={torch}>ϟ</IconButton>}
        </span>
      </TopBar>

      <div ref={area} style={{ flex: 1, position: 'relative', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
        {cameraError ? (
          <div style={{ padding: 24, textAlign: 'center', maxWidth: 420, lineHeight: 1.5 }}>
            <p style={{ opacity: 0.85 }}>{L.noCamera}</p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 16 }}>
              <Button primary onClick={props.onNativeCamera}>{L.takePhoto}</Button>
              <Button onClick={props.onPick}>{L.pickPhoto}</Button>
            </div>
          </div>
        ) : (
          <div
            style={{ position: 'relative', width: box.width || '100%', height: box.height || '100%', overflow: 'hidden' }}
            onPointerDown={onPointer}
            onPointerMove={onPointer}
            onPointerUp={onPointer}
            onPointerCancel={onPointer}
          >
            <div
              style={{
                position: 'absolute', inset: 0, transformOrigin: 'center',
                transform: zoomRange && !zoomRange.hw && zoom !== 1 ? `scale(${zoom})` : undefined,
              }}
            >
            <video ref={video} playsInline muted autoPlay style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }} />
            {dims && quad && (
              <svg viewBox={`0 0 ${dims.w} ${dims.h}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                <polygon
                  points={quad.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="rgba(46,204,113,.18)"
                  stroke={ACCENT}
                  strokeWidth={Math.max(dims.w, dims.h) / 200}
                  strokeLinejoin="round"
                />
              </svg>
            )}
            </div>
            {zoomRange && <ZoomChips range={zoomRange} zoom={zoom} onZoom={setZoom} label={L.zoom} />}
            {toast && (
              <div
                role="status"
                style={{
                  position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', padding: '6px 14px',
                  borderRadius: 999, background: 'rgba(0,0,0,.6)', fontSize: 13, whiteSpace: 'nowrap', maxWidth: '90%',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {toast}
              </div>
            )}
          </div>
        )}
      </div>

      {!cameraError && (
        <Hint>
          {!quad ? L.aimHint : touchesFrame(quad, dims) ? L.tooCloseHint : L.holdHint}
        </Hint>
      )}

      <BottomBar>
        <Button onClick={props.onPick}>{L.pickPhoto}</Button>
        <button
          aria-label={L.capture}
          onClick={capture}
          disabled={!dims}
          style={{
            width: 72, height: 72, borderRadius: '50%', border: '4px solid #fff', padding: 0, cursor: 'pointer',
            background: quad ? ACCENT : 'rgba(255,255,255,.25)', opacity: dims ? 1 : 0.4, transition: 'background .2s',
          }}
        />
        {pages > 0 ? <Button primary onClick={props.onDone}>{L.done}</Button> : <span style={{ minWidth: 96 }} />}
      </BottomBar>
    </>
  );
}

function ZoomChips({ range, zoom, onZoom, label }: { range: { min: number; max: number }; zoom: number; onZoom: (z: number) => void; label: string }) {
  const presets = [0.5, 1, 2, 3, 5, 10].filter((z) => z >= range.min - 0.01 && z <= range.max + 0.01);
  if (presets.length < 2) presets.splice(0, presets.length, range.min, range.max);
  // the chip nearest the current zoom shows the exact value, like the built-in camera app
  const nearest = presets.reduce((a, b) => (Math.abs(b - zoom) < Math.abs(a - zoom) ? b : a));
  const fmt = (z: number) => `${Math.round(z * 10) / 10}×`;
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        position: 'absolute', left: '50%', bottom: 12, transform: 'translateX(-50%)', display: 'flex', gap: 6,
        padding: 4, borderRadius: 999, background: 'rgba(0,0,0,.45)',
      }}
    >
      {presets.map((z) => {
        const active = z === nearest;
        return (
          <button
            key={z}
            aria-label={`${label} ${fmt(z)}`}
            aria-pressed={active}
            onClick={() => onZoom(z)}
            style={{
              minWidth: 40, height: 40, borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
              background: active ? 'rgba(255,255,255,.9)' : 'transparent', color: active ? '#000' : '#fff',
            }}
          >
            {active ? fmt(zoom) : fmt(z)}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- adjust */

function AdjustStage(props: {
  labels: ScannerLabels;
  source: HTMLCanvasElement;
  initial: Quad;
  onBack: () => void;
  onCrop: (corners: Quad) => void;
}) {
  const { labels: L, source } = props;
  const [q, setQ] = useState<Quad>(props.initial);
  const [drag, setDrag] = useState<number | null>(null);
  const view = useRef<HTMLCanvasElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const { ref: area, box } = useFit(source.width / source.height);

  useEffect(() => {
    const c = view.current;
    if (!c) return;
    // a display-sized copy keeps the DOM light; the full-res source is used for cropping
    const k = Math.min(1, 1600 / Math.max(source.width, source.height));
    c.width = Math.round(source.width * k);
    c.height = Math.round(source.height * k);
    c.getContext('2d')!.drawImage(source, 0, 0, c.width, c.height);
  }, [source]);

  const unit = Math.max(source.width, source.height) / Math.max(1, Math.max(box.width, box.height));

  const toImage = (e: RPointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(source.width, ((e.clientX - r.left) / r.width) * source.width)),
      y: Math.max(0, Math.min(source.height, ((e.clientY - r.top) / r.height) * source.height)),
    };
  };

  const drawLoupe = (p: { x: number; y: number }) => {
    const c = loupe.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const size = c.width, span = 60 * unit; // source pixels shown across the loupe
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(source, p.x - span / 2, p.y - span / 2, span, span, 0, 0, size, size);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size / 2, 0), ctx.lineTo(size / 2, size), ctx.moveTo(0, size / 2), ctx.lineTo(size, size / 2);
    ctx.stroke();
  };

  const onDown = (i: number) => (e: RPointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag(i);
    requestAnimationFrame(() => drawLoupe(q[i]));
  };
  const onMove = (e: RPointerEvent) => {
    if (drag === null) return;
    const p = toImage(e);
    setQ((cur) => cur.map((c, i) => (i === drag ? p : c)) as Quad);
    drawLoupe(p);
  };
  const onUp = () => setDrag(null);

  const loupeLeft = drag !== null && q[drag].x < source.width / 2;

  return (
    <>
      <TopBar>
        <span style={{ width: 44 }} />
        <span style={{ opacity: 0.85, fontSize: 14, textAlign: 'center' }}>{L.adjustHint}</span>
        <span style={{ width: 44 }} />
      </TopBar>
      <div ref={area} style={{ flex: 1, display: 'grid', placeItems: 'center', overflow: 'hidden', padding: 16 }}>
        <div style={{ position: 'relative', width: box.width, height: box.height }}>
          <canvas ref={view} style={{ width: '100%', height: '100%', display: 'block' }} />
          <svg
            ref={svg}
            viewBox={`0 0 ${source.width} ${source.height}`}
            preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            <path
              fillRule="evenodd"
              fill="rgba(0,0,0,.45)"
              d={`M0 0H${source.width}V${source.height}H0Z M${q.map((p) => `${p.x} ${p.y}`).join('L')}Z`}
            />
            <polygon points={q.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={ACCENT} strokeWidth={2.5 * unit} />
            {q.map((p, i) => (
              <g key={i}>
                {/* generous invisible touch target */}
                <circle cx={p.x} cy={p.y} r={26 * unit} fill="transparent" style={{ cursor: 'grab' }} onPointerDown={onDown(i)} />
                <circle cx={p.x} cy={p.y} r={11 * unit} fill="rgba(255,255,255,.35)" stroke={ACCENT} strokeWidth={3 * unit} pointerEvents="none" />
              </g>
            ))}
          </svg>
        </div>
      </div>
      <canvas
        ref={loupe}
        width={240}
        height={240}
        style={{
          position: 'absolute', top: 64, [loupeLeft ? 'right' : 'left']: 16, width: 120, height: 120, borderRadius: '50%',
          border: `3px solid ${ACCENT}`, display: drag === null ? 'none' : 'block', pointerEvents: 'none',
        }}
      />
      <BottomBar>
        <Button onClick={props.onBack}>{L.retake}</Button>
        <Button primary onClick={() => props.onCrop(q)}>{L.crop}</Button>
      </BottomBar>
    </>
  );
}

/* ---------------------------------------------------------------- review */

function ReviewStage(props: {
  labels: ScannerLabels;
  flat: RGBAImage;
  mode: EnhanceMode;
  modes: EnhanceMode[];
  onMode: (m: EnhanceMode) => void;
  multiple: boolean;
  onEditCrop: () => void;
  onKeep: (canvas: HTMLCanvasElement, finish: boolean) => void;
}) {
  const { labels: L, flat, mode } = props;
  const cache = useRef(new Map<EnhanceMode, HTMLCanvasElement>());
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const { ref: area, box } = useFit(flat.width / flat.height);

  useEffect(() => {
    let cancelled = false;
    const cached = cache.current.get(mode);
    if (cached) return setCanvas(cached);
    setCanvas(null);
    nextFrame().then(() => {
      if (cancelled) return;
      const c = pixelsToCanvas(enhance(flat, mode));
      cache.current.set(mode, c);
      setCanvas(c);
    });
    return () => void (cancelled = true);
  }, [flat, mode]);

  useEffect(() => {
    const h = holder.current;
    if (!h || !canvas) return;
    Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block', background: '#fff' });
    h.replaceChildren(canvas);
  }, [canvas]);

  return (
    <>
      <TopBar>
        <Button onClick={props.onEditCrop}>{L.editCrop}</Button>
        <span />
        <span />
      </TopBar>
      <div ref={area} style={{ flex: 1, display: 'grid', placeItems: 'center', overflow: 'hidden', padding: 16 }}>
        <div ref={holder} style={{ width: box.width, height: box.height, boxShadow: '0 4px 24px rgba(0,0,0,.6)' }} />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', padding: '4px 12px', flexWrap: 'wrap' }}>
        {props.modes.map((m) => (
          <button
            key={m}
            onClick={() => props.onMode(m)}
            style={{
              padding: '8px 14px', borderRadius: 999, border: '1px solid rgba(255,255,255,.35)', fontSize: 14, cursor: 'pointer',
              background: m === mode ? '#fff' : 'transparent', color: m === mode ? '#000' : '#fff',
            }}
          >
            {L.modes[m]}
          </button>
        ))}
      </div>
      <BottomBar>
        {props.multiple ? (
          <Button disabled={!canvas} onClick={() => canvas && props.onKeep(canvas, false)}>{L.addPage}</Button>
        ) : (
          <span />
        )}
        <Button primary disabled={!canvas} onClick={() => canvas && props.onKeep(canvas, true)}>{L.done}</Button>
      </BottomBar>
    </>
  );
}

/* ---------------------------------------------------------------- bits */

const bar: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 16px' };

function TopBar({ children }: { children: ReactNode }) {
  return <div style={{ ...bar, paddingTop: 'max(10px, env(safe-area-inset-top))', minHeight: 44 }}>{children}</div>;
}

function BottomBar({ children }: { children: ReactNode }) {
  return <div style={{ ...bar, padding: '16px 20px', paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>{children}</div>;
}

function Hint({ children }: { children: ReactNode }) {
  return <div style={{ textAlign: 'center', fontSize: 14, opacity: 0.85, padding: '6px 16px 0' }}>{children}</div>;
}

function Button({ children, onClick, primary, disabled }: { children: ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        minWidth: 96, padding: '10px 18px', borderRadius: 999, fontSize: 15, fontWeight: 600, cursor: 'pointer',
        border: primary ? 'none' : '1px solid rgba(255,255,255,.4)',
        background: primary ? ACCENT : 'rgba(255,255,255,.08)', color: primary ? '#04210f' : '#fff', opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function IconButton({ children, onClick, label, active }: { children: ReactNode; onClick: () => void; label: string; active?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 44, height: 44, borderRadius: '50%', border: 'none', fontSize: 20, cursor: 'pointer',
        background: active ? '#ffd54a' : 'rgba(255,255,255,.12)', color: active ? '#000' : '#fff',
      }}
    >
      {children}
    </button>
  );
}
