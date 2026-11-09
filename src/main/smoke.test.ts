import { describe, expect, it } from 'vitest';
import { failCmd, sleepCmd, testPlatform } from './test-helpers/shell';
import { TerminalManager, UNKNOWN_EXIT } from './services/TerminalManager';
import { runSmoke } from './smoke';

describe('runSmoke', () => {
  it('spawns a pty, sees its output and a clean exit', async () => {
    const lines: string[] = [];
    const ok = await runSmoke({
      terminals: new TerminalManager(),
      platform: testPlatform(),
      log: (l) => lines.push(l),
    });
    expect(lines.join('\n')).not.toMatch(/failed/);
    expect(ok).toBe(true);
  });

  it('fails when the main process cannot be profiled', async () => {
    const lines: string[] = [];
    const ok = await runSmoke({
      terminals: new TerminalManager(),
      platform: testPlatform(),
      log: (l) => lines.push(l),
      profiler: () => ({
        start: async () => {
          throw new Error('no inspector');
        },
        stop: async () => {
          throw new Error('not started');
        },
        dispose: () => undefined,
      }),
    });
    expect(ok).toBe(false);
    expect(lines.join('\n')).toMatch(/smoke failed: profiler/);
  });

  it('fails when the brain canvas cannot be loaded', async () => {
    const lines: string[] = [];
    const ok = await runSmoke({
      terminals: new TerminalManager(),
      platform: testPlatform(),
      log: (l) => lines.push(l),
      canvas: async () => null,
    });
    expect(ok).toBe(false);
    expect(lines.join('\n')).toMatch(/canvas could not be loaded/);
  });

  it('fails when the canvas loads but cannot encode', async () => {
    const lines: string[] = [];
    const ok = await runSmoke({
      terminals: new TerminalManager(),
      platform: testPlatform(),
      log: (l) => lines.push(l),
      canvas: async () =>
        ({
          createCanvas: () => ({
            getContext: () => ({ fillRect: () => {} }),
            encode: async () => Buffer.alloc(0),
          }),
        }) as unknown as Awaited<
          ReturnType<typeof import('./brain/convert/raster').loadCanvas>
        >,
    });
    expect(ok).toBe(false);
    expect(lines.join('\n')).toMatch(/empty PNG/);
  });

  it('fails when the command exits non-zero', async () => {
    const p = testPlatform();
    const lines: string[] = [];
    const ok = await runSmoke({
      terminals: new TerminalManager(),
      platform: { ...p, runCommand: () => p.runCommand(failCmd(3)) },
      log: (l) => lines.push(l),
    });
    expect(ok).toBe(false);
    expect(lines.join('\n')).toMatch(/exit code 3/);
  });

  it('fails after the timeout', async () => {
    const p = testPlatform();
    const terminals = new TerminalManager();
    const lines: string[] = [];
    const ok = await runSmoke({
      terminals,
      platform: { ...p, runCommand: () => p.runCommand(sleepCmd(30)) },
      log: (l) => lines.push(l),
      timeoutMs: 500,
    });
    expect(ok).toBe(false);
    expect(lines.join('\n')).toMatch(/timed out/);
    expect(terminals.ids()).toEqual([]);
  });

  it('fails when the pty cannot be spawned', async () => {
    const lines: string[] = [];
    const ok = await runSmoke({
      terminals: new TerminalManager(),
      platform: {
        ...testPlatform(),
        runCommand: () => ({
          command: 'x',
          args: [1 as unknown as string],
        }),
      },
      log: (l) => lines.push(l),
    });
    expect(ok).toBe(false);
  });

  it('passes on the marker when the pty reports no exit code', async () => {
    const terminals = new TerminalManager();
    const lines: string[] = [];
    // node-pty with conpty.dll can report exit before the code is known; TerminalManager then says UNKNOWN_EXIT.
    const realOn = terminals.on.bind(terminals);
    terminals.on = ((event: 'exit' | 'data', listener: never) => {
      if (event !== 'exit') return realOn(event, listener);
      const wrapped = (id: string) =>
        (listener as (id: string, code: number) => void)(id, UNKNOWN_EXIT);
      return realOn('exit', wrapped);
    }) as typeof terminals.on;
    const ok = await runSmoke({
      terminals,
      platform: testPlatform(),
      log: (l) => lines.push(l),
    });
    expect(ok).toBe(true);
    expect(lines.join('\n')).toMatch(/no exit code/);
  });
});
