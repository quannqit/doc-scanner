import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';

// Drop a key.pem/cert.pem pair in demo-ml/cert to serve over HTTPS — needed for the camera
// when you open the page from a phone (getUserMedia requires a secure context).
const certDir = join(__dirname, 'cert');
const https = existsSync(join(certDir, 'key.pem'))
  ? { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }
  : undefined;

export default defineConfig({
  root: __dirname,
  base: './',
  // ort resolves its .wasm with `new URL(..., import.meta.url)`, which only Vite's own pipeline rewrites
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: { port: 5175, host: true, https, fs: { allow: ['..'] } },
  build: { outDir: '../demo-ml-dist', emptyOutDir: true },
});
