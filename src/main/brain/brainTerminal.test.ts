import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrainSchema } from '../../shared/brain';
import type { Platform } from '../platform/Platform';
import { windowsPlatform } from '../platform/windows';
import type { TerminalManager } from '../services/TerminalManager';
import type { SpawnOptions } from '../services/TerminalManager';
import { testPlatform } from '../test-helpers/shell';
import { BrainStore } from './BrainStore';
import { brainOpencodePermission } from './templates';
import {
  brainClaudeArgs,
  brainOpencodeArgs,
  createBrainTerminals,
} from './brainTerminal';

let dir: string;
let store: BrainStore;
let spawned: SpawnOptions[];
let running: Set<string>;
let exited: Set<string>;
let killed: string[];
let written: [string, string][];
let found: string | null;
let lookups: number[];
/** What OpenCode's database says about a stored session: null is no database (unknown). */
let ocExists: boolean | null;
let ocAsked: string[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-terminal-'));
  store = new BrainStore(path.join(dir, 'brains.json'));
  await store.load();
  await store.add(
    BrainSchema.parse({
      id: 'b1',
      name: 'Acme',
      connectionId: 'c1',
      project: 'Acme',
      path: '/x/b1',
      createdAt: 't',
    }),
  );
  spawned = [];
  killed = [];
  written = [];
  running = new Set();
  exited = new Set();
  found = null;
  lookups = [];
  ocExists = null;
  ocAsked = [];
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const make = (
  exists = true,
  over: { platform?: Platform; env?: Record<string, string> } = {},
) => {
  const terminals = {
    spawn: (o: SpawnOptions) => {
      if (running.has(o.id) || exited.has(o.id))
        throw new Error(`Terminal ${o.id} already exists`);
      spawned.push(o);
      running.add(o.id);
    },
    isRunning: (id: string) => running.has(id),
    has: (id: string) => running.has(id) || exited.has(id),
    kill: async (id: string) => {
      killed.push(id);
      running.delete(id);
      exited.delete(id);
    },
    write: (id: string, data: string) => written.push([id, data]),
  } as unknown as TerminalManager;
  return createBrainTerminals({
    brains: store,
    terminals,
    platform: over.platform ?? testPlatform(),
    env: (id) => ({ SHELLIE_TEST: id, ...over.env }),
    themeFile: () => null,
    sessionExists: () => exists,
    opencodeSession: (_b, since) => {
      lookups.push(since);
      return found;
    },
    opencodeSessionExists: (id) => {
      ocAsked.push(id);
      return ocExists;
    },
    opencodeAttention: () => ({
      env: {
        SHELLIE_ATTENTION_URL: 'http://a',
        SHELLIE_ATTENTION_TOKEN: 'tok',
      },
      plugin: '/u/opencode/shellie-attention.js',
    }),
    now: () => 1000,
    wait: async () => undefined,
  });
};

const line = (o: SpawnOptions) => [o.command, ...o.args].join(' ');

describe('brainClaudeArgs', () => {
  it('resumes, continues or starts a session, with the theme file', () => {
    const def = { id: 't', kind: 'claude' as const, label: 'l' };
    expect(
      brainClaudeArgs({ ...def, sessionId: 's' }, true, () => true, null),
    ).toEqual(['--resume', 's']);
    expect(brainClaudeArgs(def, true, () => true, '/th.json')).toEqual([
      '--continue',
      '--settings',
      '/th.json',
    ]);
    expect(
      brainClaudeArgs({ ...def, sessionId: 's' }, false, () => true, null),
    ).toEqual(['--session-id', 's']);
  });
});

describe('createBrainTerminals', () => {
  it('opens a brain terminal in the brain folder with the brain task id', async () => {
    const bt = make();
    const def = await bt.open('b1');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      id: 'brain-b1',
      taskId: 'brain:b1',
      cwd: '/x/b1',
      env: { SHELLIE_TEST: 'b1' },
    });
    expect(line(spawned[0])).toContain('--session-id');
    expect(def.sessionId).toBeTruthy();
    expect(store.get('b1')?.terminal).toEqual(def);
    expect(line(spawned[0])).toContain(def.sessionId);
  });

  it('does not spawn again while running', async () => {
    const bt = make();
    const a = await bt.open('b1');
    const b = await bt.open('b1');
    expect(b).toEqual(a);
    expect(spawned).toHaveLength(1);
  });

  it('opens with a given session to resume and stores it', async () => {
    const bt = make();
    const def = await bt.open('b1', 'old');
    expect(def.sessionId).toBe('old');
    expect(line(spawned[0])).toContain('--resume');
    expect(line(spawned[0])).toContain('old');
  });

  it('replaces a running terminal on another session with one resuming it', async () => {
    const bt = make();
    await bt.open('b1', 'A');
    const def = await bt.open('b1', 'B');
    expect(killed).toEqual(['brain-b1']);
    expect(spawned).toHaveLength(2);
    // Quoted for the shell, or plain arguments to claude.exe.
    expect(line(spawned[1])).toMatch(/'?--resume'? '?B'?/);
    expect(def.sessionId).toBe('B');
    expect(store.get('b1')?.terminal?.sessionId).toBe('B');
    // The same session again: the running terminal stays.
    await bt.open('b1', 'B');
    expect(spawned).toHaveLength(2);
  });

  it('starts a fresh terminal with the prompt as its first message', async () => {
    const bt = make();
    await bt.open('b1', 'A', 'Why is the scope page stale?');
    expect(written).toEqual([]);
    const o = spawned[0];
    expect(line(o) + JSON.stringify(o.env)).toContain(
      'Why is the scope page stale?',
    );
  });

  it('types the prompt into a running terminal, then Enter', async () => {
    const bt = make();
    await bt.open('b1');
    await bt.open('b1', null, 'What did we agree?');
    expect(spawned).toHaveLength(1);
    expect(written).toEqual([
      ['brain-b1', 'What did we agree?'],
      ['brain-b1', '\r'],
    ]);
  });

  it('restart resumes the stored session', async () => {
    const bt = make();
    const def = await bt.open('b1');
    expect(await bt.restart('brain-b1')).toBe(true);
    expect(killed).toEqual(['brain-b1']);
    expect(spawned).toHaveLength(2);
    expect(line(spawned[1])).toContain('--resume');
    expect(line(spawned[1])).toContain(def.sessionId);
  });

  it('reopens and restarts a terminal whose process exited', async () => {
    const bt = make();
    const def = await bt.open('b1');
    running.delete('brain-b1');
    exited.add('brain-b1');
    await bt.open('b1');
    expect(spawned).toHaveLength(2);
    expect(line(spawned[1])).toContain('--resume');
    expect(line(spawned[1])).toContain(def.sessionId);
    running.delete('brain-b1');
    exited.add('brain-b1');
    expect(await bt.restart('brain-b1')).toBe(true);
    expect(spawned).toHaveLength(3);
  });

  it('spawns once for two concurrent opens', async () => {
    const bt = make();
    const [a, b] = await Promise.all([bt.open('b1'), bt.open('b1')]);
    expect(spawned).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it('kill stops a brain terminal only', async () => {
    const bt = make();
    await bt.open('b1');
    expect(await bt.kill('nope')).toBe(false);
    expect(await bt.kill('brain-b1')).toBe(true);
    expect(killed).toEqual(['brain-b1']);
  });

  it('ownerOf finds the brain by terminal id and returns undefined otherwise', async () => {
    const bt = make();
    expect(bt.ownerOf('brain-b1')).toBeUndefined();
    await bt.open('b1');
    expect(bt.ownerOf('brain-b1')?.id).toBe('b1');
    expect(bt.ownerOf('x')).toBeUndefined();
    expect(await bt.restart('x')).toBe(false);
  });
});

const onOpencode = (opencodeModel: string | null = null) =>
  store.patch('b1', {
    options: { ...store.get('b1')!.options, agent: 'opencode', opencodeModel },
  });

describe('brainOpencodeArgs', () => {
  it('resumes a stored session, with the model', () => {
    const def = { id: 't', kind: 'opencode' as const, label: 'l' };
    expect(brainOpencodeArgs(def, null)).toEqual([]);
    expect(
      brainOpencodeArgs({ ...def, sessionId: 'ses_1' }, 'opencode/big'),
    ).toEqual(['--session', 'ses_1', '-m', 'opencode/big']);
  });

  it('leaves out a typed model that is not a plain provider/model', () => {
    const def = { id: 't', kind: 'opencode' as const, label: 'l' };
    expect(brainOpencodeArgs(def, 'a/b" & calc')).toEqual([]);
    expect(brainOpencodeArgs(def, 'a/b c')).toEqual([]);
  });
});

describe('createBrainTerminals on OpenCode', () => {
  it('keeps a Claude brain on Claude', async () => {
    const bt = make();
    const def = await bt.open('b1');
    expect(def.kind).toBe('claude');
    expect(lookups).toEqual([]);
  });

  it('starts OpenCode in the brain folder, never --continue, and records the spawn time', async () => {
    await onOpencode('opencode/big');
    const bt = make();
    const def = await bt.open('b1', null, 'Load the ask skill: q');
    expect(def).toMatchObject({ id: 'brain-b1', kind: 'opencode' });
    expect(def.sessionId).toBeUndefined();
    const command = testPlatform().opencodeCommand(
      undefined,
      brainOpencodeArgs(def, 'opencode/big'),
      'Load the ask skill: q',
    );
    expect(spawned[0]).toMatchObject({
      id: 'brain-b1',
      taskId: 'brain:b1',
      cwd: '/x/b1',
      command: command.command,
      args: command.args,
    });
    expect(line(spawned[0])).not.toContain('--continue');
    expect(line(spawned[0])).not.toContain('--session');
    // Never spawned before: nothing to look for, a new session.
    expect(lookups).toEqual([]);
    expect(store.get('b1')?.terminal).toMatchObject({
      kind: 'opencode',
      spawnedAt: 1000,
    });
  });

  it('finds the session the last spawn made and resumes it', async () => {
    await onOpencode();
    const bt = make();
    await bt.open('b1');
    running.delete('brain-b1');
    exited.add('brain-b1');
    found = 'ses_term';
    const def = await bt.open('b1');
    expect(lookups).toEqual([1000]);
    expect(def.sessionId).toBe('ses_term');
    expect(store.get('b1')?.terminal?.sessionId).toBe('ses_term');
    expect(line(spawned[1])).toMatch(/'?--session'? '?ses_term'?/);
  });

  it('types into a running OpenCode terminal, then Enter', async () => {
    await onOpencode();
    const bt = make();
    await bt.open('b1');
    await bt.open('b1', null, 'Load the ask skill: q');
    expect(spawned).toHaveLength(1);
    expect(written).toEqual([
      ['brain-b1', 'Load the ask skill: q'],
      ['brain-b1', '\r'],
    ]);
  });

  it('respawns on the job agent when Continue asks for the other one', async () => {
    const bt = make();
    await bt.open('b1');
    const def = await bt.open('b1', 'ses_job', undefined, 'opencode');
    expect(killed).toEqual(['brain-b1']);
    expect(def).toMatchObject({ kind: 'opencode', sessionId: 'ses_job' });
    // Continue names its session: no lookup.
    expect(lookups).toEqual([]);
    expect(line(spawned[1])).toMatch(/'?--session'? '?ses_job'?/);
    expect(store.get('b1')?.terminal?.kind).toBe('opencode');
  });

  it('a running terminal on the old agent is replaced after the brain switched', async () => {
    const bt = make();
    await bt.open('b1');
    await onOpencode();
    const def = await bt.open('b1');
    expect(killed).toEqual(['brain-b1']);
    expect(def.kind).toBe('opencode');
    expect(def.sessionId).toBeUndefined();
    expect(lookups).toEqual([]);
    expect(store.get('b1')?.terminal?.spawnedAt).toBe(1000);
  });

  it('Continue on a running OpenCode terminal without a session does not look one up', async () => {
    await onOpencode();
    const bt = make();
    await bt.open('b1');
    found = 'ses_term';
    const def = await bt.open('b1', 'ses_job');
    expect(lookups).toEqual([]);
    expect(def.sessionId).toBe('ses_job');
  });

  it('restart resumes the stored OpenCode session', async () => {
    await onOpencode();
    const bt = make();
    await bt.open('b1', 'ses_1');
    expect(await bt.restart('brain-b1')).toBe(true);
    expect(line(spawned[1])).toMatch(/'?--session'? '?ses_1'?/);
  });

  it("never puts the prompt in a Windows shim's command line", async () => {
    await onOpencode('a/b" & calc');
    const platform = windowsPlatform(
      {},
      { which: (n) => (n === 'opencode' ? 'C:\\npm\\opencode.cmd' : null) },
    );
    const bt = make(true, { platform });
    await bt.open('b1', null, 'Fix "x" & del C:\\ | y');
    const command = spawned[0].args.at(-1) ?? '';
    expect(command).toBe(
      "& opencode '--prompt' $env:SHELLIE_CLAUDE_FIRST_MESSAGE",
    );
    expect(spawned[0].env?.SHELLIE_CLAUDE_FIRST_MESSAGE).toBe(
      "Fix 'x' del C:\\ y",
    );
  });

  it("shields the brain's rules from the developer's own inline config and loads the attention plugin", async () => {
    await onOpencode();
    const bt = make(true, {
      env: {
        OPENCODE_CONFIG_CONTENT:
          '{"permission":{"edit":{"sources/**":"allow"},"bash":"allow"}}',
      },
    });
    await bt.open('b1');
    const env = spawned[0].env ?? {};
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      permission: brainOpencodePermission(),
      plugin: ['/u/opencode/shellie-attention.js'],
    });
    expect(env).toMatchObject({
      SHELLIE_TEST: 'b1',
      SHELLIE_ATTENTION_URL: 'http://a',
      SHELLIE_ATTENTION_TOKEN: 'tok',
    });
  });

  it("leaves a Claude brain terminal's env as it was", async () => {
    const bt = make(true, { env: { OPENCODE_CONFIG_CONTENT: '{}' } });
    await bt.open('b1');
    expect(spawned[0].env).toEqual({
      SHELLIE_TEST: 'b1',
      OPENCODE_CONFIG_CONTENT: '{}',
    });
  });

  it('starts a new session when the stored one is gone from OpenCode, and resumes it when unknown', async () => {
    await onOpencode();
    const bt = make();
    await bt.open('b1', 'ses_gone');
    // No database: unknown, resumed as before.
    expect(line(spawned[0])).toMatch(/'?--session'? '?ses_gone'?/);
    running.delete('brain-b1');
    exited.add('brain-b1');
    ocExists = false;
    const def = await bt.open('b1');
    expect(ocAsked).toContain('ses_gone');
    expect(line(spawned[1])).not.toContain('--session');
    expect(def.sessionId).toBeUndefined();
    expect(def.spawnedAt).toBe(1000);
    expect(store.get('b1')?.terminal?.sessionId).toBeUndefined();
  });

  it('restart starts a new session when the stored one is gone', async () => {
    await onOpencode();
    const bt = make();
    await bt.open('b1', 'ses_1');
    ocExists = false;
    expect(await bt.restart('brain-b1')).toBe(true);
    expect(line(spawned[1])).not.toContain('--session');
    expect(store.get('b1')?.terminal).toMatchObject({ spawnedAt: 1000 });
    expect(store.get('b1')?.terminal?.sessionId).toBeUndefined();
  });
});
