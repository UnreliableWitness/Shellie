import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: [
            'src/main/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'tools/art/*.test.ts',
            'tools/forge/*.test.ts',
            'tools/release/*.test.ts',
            'tools/agents/*.test.ts',
          ],
          // tests that run real git are slow on the Windows CI runner (the suite takes ~15 min there, ~4 on macOS)
          testTimeout: process.platform === 'win32' ? 60000 : 20000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['src/renderer/test-setup.ts'],
          // waitFor allows 5 s per check (test-setup.ts), so a test with a few checks needs more than the default 5 s
          testTimeout: 20000,
        },
      },
    ],
  },
});
