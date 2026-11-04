import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    // App Insights connection string, injected by CI (repo variable APPINSIGHTS_CONNECTION_STRING).
    // Local builds without it send no telemetry. See docs/telemetry.md.
    __APPINSIGHTS_CONNECTION_STRING__: JSON.stringify(
      process.env.APPINSIGHTS_CONNECTION_STRING ?? '',
    ),
  },
  build: {
    rollupOptions: {
      external: ['node-pty', '@napi-rs/canvas'],
    },
  },
});
