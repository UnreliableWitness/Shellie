import { describe, expect, it } from 'vitest';
import type { Platform } from '../platform/Platform';
import { detectAgents, opencodeModels, runProbe } from './agentDetector';

const platform = {
  shellLabel: 'zsh',
  probeCommand: (name: string) => ({ command: 'probe', args: [name] }),
} as unknown as Platform;

describe('detectAgents', () => {
  it('reads the path and version, and marks missing agents', async () => {
    const r = await detectAgents(platform, async (cmd) =>
      cmd.args[0] === 'claude'
        ? { code: 0, stdout: '/usr/local/bin/claude\n2.1.307 (Claude Code)\n' }
        : { code: 1, stdout: '' },
    );
    expect(r.agents.claude).toEqual({
      found: true,
      version: '2.1.307',
      path: '/usr/local/bin/claude',
    });
    expect(r.agents.copilot).toEqual({
      found: false,
      version: null,
      path: null,
    });
    expect(r.agents.opencode.found).toBe(false);
    expect(r.shell).toEqual({ label: 'zsh' });
    expect(new Date(r.checkedAt).toISOString()).toBe(r.checkedAt);
  });

  it('leaves the full stop of the sentence out of the version', async () => {
    const r = await detectAgents(platform, async (cmd) =>
      cmd.args[0] === 'copilot'
        ? {
            code: 0,
            stdout: '/opt/homebrew/bin/copilot\nGitHub Copilot CLI 1.0.57.\n',
          }
        : { code: 0, stdout: '/bin/x\n1.19.3-beta.2\n' },
    );
    expect(r.agents.copilot.version).toBe('1.0.57');
    expect(r.agents.opencode.version).toBe('1.19.3-beta.2');
  });

  it('treats a timeout as not found', async () => {
    const r = await detectAgents(platform, async () => {
      throw new Error('timed out');
    });
    expect(r.agents.claude.found).toBe(false);
  });

  it('runs the probes in parallel with a 5 s timeout', async () => {
    const seen: number[] = [];
    let open = 0;
    let peak = 0;
    await detectAgents(platform, async (_c, ms) => {
      seen.push(ms);
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 5));
      open -= 1;
      return { code: 1, stdout: '' };
    });
    expect(seen).toEqual([5000, 5000, 5000]);
    expect(peak).toBe(3);
  });

  it('counts a printed path as found when --version times out or fails', async () => {
    const r = await detectAgents(platform, async (cmd) =>
      cmd.args[0] === 'copilot'
        ? { code: -1, stdout: '/opt/homebrew/bin/copilot\n' }
        : cmd.args[0] === 'claude'
          ? { code: 1, stdout: '/usr/local/bin/claude\n' }
          : { code: 1, stdout: '' },
    );
    expect(r.agents.copilot).toEqual({
      found: true,
      version: null,
      path: '/opt/homebrew/bin/copilot',
    });
    expect(r.agents.claude).toEqual({
      found: true,
      version: null,
      path: '/usr/local/bin/claude',
    });
    expect(r.agents.opencode.found).toBe(false);
  });

  it('skips a login banner before the path', async () => {
    const r = await detectAgents(platform, async (cmd) =>
      cmd.args[0] === 'claude'
        ? {
            code: 0,
            stdout:
              'Welcome back, last login 09:12\n/usr/local/bin/claude\n2.1.307 (Claude Code)\n',
          }
        : cmd.args[0] === 'opencode'
          ? {
              code: 0,
              stdout: 'C:\\Users\\me\\opencode.exe\r\nbanner only\r\n',
            }
          : { code: 0, stdout: 'Welcome back\n' },
    );
    expect(r.agents.claude).toEqual({
      found: true,
      version: '2.1.307',
      path: '/usr/local/bin/claude',
    });
    expect(r.agents.opencode).toEqual({
      found: true,
      version: null,
      path: 'C:\\Users\\me\\opencode.exe',
    });
    expect(r.agents.copilot.found).toBe(false);
  });
});

describe('runProbe', () => {
  it('resolves with the output printed before a timeout', async () => {
    const r = await runProbe(
      {
        command: process.execPath,
        args: [
          '-e',
          "process.stdout.write('/usr/bin/agent\\n'); setTimeout(() => {}, 10000)",
        ],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
      500,
    );
    expect(r.stdout).toBe('/usr/bin/agent\n');
    expect(r.code).not.toBe(0);
  });

  it('resolves a non-zero exit with its code and output', async () => {
    const r = await runProbe(
      {
        command: process.execPath,
        args: ['-e', "process.stdout.write('/x\\n'); process.exit(3)"],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
      5000,
    );
    expect(r).toEqual({ code: 3, stdout: '/x\n' });
  });

  it('rejects when the command cannot start', async () => {
    await expect(
      runProbe({ command: '/no/such/binary-shellie', args: [] }, 1000),
    ).rejects.toThrow();
  });
});

describe('opencodeModels', () => {
  const oc = {
    opencodeCommand: (_cwd: unknown, args: string[]) => ({
      command: 'opencode',
      args,
    }),
  } as unknown as Platform;

  it('lists the provider/model lines of `opencode models`', async () => {
    let asked: unknown;
    const list = await opencodeModels(oc, async (cmd, ms) => {
      asked = { cmd, ms };
      return { code: 0, stdout: 'zai/glm-5\r\nnot a model\nanthropic/x\n' };
    });
    expect(list).toEqual(['zai/glm-5', 'anthropic/x']);
    expect(asked).toEqual({
      cmd: { command: 'opencode', args: ['models'] },
      ms: 15_000,
    });
  });

  it('is null for a failed run, an empty list or a missing program', async () => {
    expect(
      await opencodeModels(oc, async () => ({ code: 1, stdout: 'a/b' })),
    ).toBeNull();
    expect(
      await opencodeModels(oc, async () => ({ code: 0, stdout: '\n' })),
    ).toBeNull();
    expect(
      await opencodeModels(oc, async () => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
  });
});
