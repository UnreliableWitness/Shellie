import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The phone reading site. Built into reader/dist/public, which the reader server serves (tools/reader/build.mjs).
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: path.resolve(here, '../dist/public'),
    emptyOutDir: true,
    // One script on purpose: the service worker keeps what index.html names, so the whole site works offline.
    chunkSizeWarningLimit: 700,
  },
});
