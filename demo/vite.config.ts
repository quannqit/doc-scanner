import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  base: './',
  esbuild: { jsx: 'automatic' },
  server: { host: true, port: 5180 },
  build: { outDir: '../demo-dist', emptyOutDir: true },
});
