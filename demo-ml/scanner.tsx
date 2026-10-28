// Checks the `detector` prop on the real <DocumentScanner />: a stub detector counts its calls and
// returns a fixed quad, so a screenshot proves the live loop goes through it and draws the result.
import { createRoot } from 'react-dom/client';
import { DocumentScanner } from '../src/react/index.js';
import type { Detector } from '../src/types.js';

declare global {
  interface Window {
    __calls?: number;
    __lastShape?: string;
  }
}

const stub: Detector = async (frame) => {
  window.__calls = (window.__calls ?? 0) + 1;
  window.__lastShape = `${frame.width}x${frame.height}`;
  const w = frame.width, h = frame.height;
  return [
    { x: w * 0.18, y: h * 0.18 },
    { x: w * 0.82, y: h * 0.2 },
    { x: w * 0.8, y: h * 0.82 },
    { x: w * 0.2, y: h * 0.8 },
  ];
};

createRoot(document.getElementById('root')!).render(
  <DocumentScanner detector={stub} onDone={() => {}} onCancel={() => {}} />,
);
