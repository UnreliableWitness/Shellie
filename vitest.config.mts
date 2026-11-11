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
            'reader/server/**/*.test.ts',
            'tools/art/*.test.ts',
            'tools/forge/*.test.ts',
            'tools/release/*.test.ts',
            'tools/agents/*.test.ts',
          ],
          // tests that run real git are slow on the Windows CI runner (the suite takes ~15 min there, ~4 on macOS);
          // so are the hooks that build their repos (a scaffold is five git calls), which kept vitest's 10 s default
          testTimeout: process.platform === 'win32' ? 60000 : 20000,
          hookTimeout: process.platform === 'win32' ? 60000 : 20000,
          // No background git maintenance in test repos: once a repo has 100 loose objects a commit starts one, which
          // writes into .git/objects/pack while the test removes the folder (ENOTEMPTY in afterEach).
          env: {
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'maintenance.auto',
            GIT_CONFIG_VALUE_0: 'false',
            GIT_CONFIG_KEY_1: 'gc.auto',
            GIT_CONFIG_VALUE_1: '0',
          },
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
      {
        plugins: [react()],
        test: {
          name: 'reader-site',
          environment: 'jsdom',
          include: ['reader/site/**/*.test.{ts,tsx}'],
          setupFiles: ['reader/site/test-setup.ts'],
          testTimeout: 20000,
        },
      },
    ],
  },
});
