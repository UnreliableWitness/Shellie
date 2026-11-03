import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrainSchema } from '../../shared/brain';
import type { TerminalManager } from '../services/TerminalManager';
import type { SpawnOptions } from '../services/TerminalManager';
import { testPlatform } from '../test-helpers/shell';
import { BrainStore } from './BrainStore';
import { brainClaudeArgs, createBrainTerminals } from './brainTerminal';

let dir: string;
let store: BrainStore;
let spawned: SpawnOptions[];
let running: Set<string>;
let exited: Set<string>;
let killed: string[];
let written: [string, string][];

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
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const make = (exists = true) => {
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
    platform: testPlatform(),
    env: (id) => ({ SHELLIE_TEST: id }),
    themeFile: () => null,
    sessionExists: () => exists,
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
