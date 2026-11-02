import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../shared/usage';
import { startTaskFor } from './startTask';
import { installFakeApi, noOverrides } from './test-helpers/fakeApi';

const config = {
  worktreeRoot: '/w',
  ...noOverrides,
  config: {
    base: 'main',
    branch: '{type}/{id}-{slug}',
    copy: [],
    setup: ['npm ci'],
    run: {},
    found: true,
  },
};

describe('startTaskFor', () => {
  it('opens the tabs chosen in Settings', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'settings:get': () => ({
        ...defaultSettings(),
        defaultTerminals: {
          claude: false,
          copilot: false,
          opencode: true,
          shell: false,
        },
      }),
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    await startTaskFor(
      'r1',
      { id: '5', type: 'Task', title: 'Store the address', url: null },
      vi.fn(),
    );
    expect(
      calls.find((c) => c.channel === 'tasks:create')?.args[0],
    ).toMatchObject({
      startClaude: false,
      openShell: false,
      openCopilot: false,
      openOpencode: true,
    });
  });

  it('uses the repo default environment, Development or Test', async () => {
    const { calls } = installFakeApi({
      'repos:config': () => config,
      'secrets:repoDefault': () => 'test',
      'tasks:create': () => ({ id: 't1' }) as never,
    });
    await startTaskFor(
      'r1',
      { id: '5', type: 'Task', title: 'Store the address', url: null },
      vi.fn(),
    );
    expect(
      calls.find((c) => c.channel === 'tasks:create')?.args[0],
    ).toMatchObject({ environment: 'test' });
  });

  it('never starts on UAT or Production, even when a repo default says so', async () => {
    for (const env of ['uat', 'production'] as const) {
      const { calls } = installFakeApi({
        'repos:config': () => config,
        'secrets:repoDefault': () => env,
        'tasks:create': () => ({ id: 't1' }) as never,
      });
      await startTaskFor(
        'r1',
        { id: '5', type: 'Task', title: 'Store the address', url: null },
        vi.fn(),
      );
      const input = calls.find((c) => c.channel === 'tasks:create')
        ?.args[0] as Record<string, unknown>;
      expect(input.environment).toBe('development');
      expect(input.environmentConfirmed).toBeUndefined();
    }
  });
});
