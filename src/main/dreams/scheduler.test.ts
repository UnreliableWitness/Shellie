import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DreamResult, DreamingSettings } from '../../shared/dreams';
import { AppSettingsSchema, type AppSettings } from '../../shared/usage';
import { GitClient } from '../services/GitClient';
import { cleanupTempRepos, git, makeRepo } from '../test-helpers/gitRepo';
import type { DreamOutcome } from './DreamRunner';
import { DreamStore } from './DreamStore';
import type { TaskSessions } from './material';
import {
  DREAM_TICK_MS,
  startDreamScheduler,
  type DreamSchedulerDeps,
} from './scheduler';

const MODEL = 'zai/glm-5';
const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();
const REPO = { id: 'r1', name: 'Portal', path: '/nowhere/portal' };

const task = (id: string, at = NOW - 60_000): TaskSessions => ({
  taskId: id,
  label: `Label ${id}`,
  workItemId: 7,
  createdAt: '2026-11-19T10:00:00.000Z',
  agents: ['claude'],
  sessions: [[{ who: 'Developer', text: 'use the helper', at }]],
});

const dreaming = (over: Partial<DreamingSettings> = {}): DreamingSettings => ({
  enabled: true,
  model: MODEL,
  testedModel: MODEL,
  limit: { kind: 'none' },
  repos: { [REPO.id]: { on: true, folders: ['.apm'] } },
  idleMinutes: 10,
  ...over,
});

/** A runner whose dream waits until `finish`, or ends as interrupted when its signal aborts. */
function fakeRunner() {
  const calls: { repoId: string; signal: AbortSignal; model: string }[] = [];
  let settle: ((o: DreamOutcome) => void) | null = null;
  let current: { repoId: string; startedAt: number; step: 'reading' } | null =
    null;
  const runner: DreamSchedulerDeps['runner'] = {
    running: () => current,
    dream: (repo, o) => {
      calls.push({ repoId: repo.id, signal: o.signal, model: o.model });
      current = { repoId: repo.id, startedAt: Date.now(), step: 'reading' };
      return new Promise<DreamOutcome>((resolve) => {
        settle = (out) => {
          current = null;
          settle = null;
          resolve(out);
        };
        o.signal.addEventListener('abort', () =>
          settle?.({
            outcome: 'interrupted',
            why: o.signal.reason as 'stopped' | 'suspend',
          }),
        );
      });
    },
  };
  return {
    runner,
    calls,
    finish: (o: DreamOutcome) => settle?.(o),
  };
}

let dir: string;
let store: DreamStore;
let app: AppSettings;
let idle: number;
let sessions: TaskSessions[];
let fake: ReturnType<typeof fakeRunner>;
let deps: DreamSchedulerDeps;
let scheduler: ReturnType<typeof startDreamScheduler> | null;

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW });
  dir = mkdtempSync(path.join(tmpdir(), 'dream-sched-'));
  store = new DreamStore(dir, () => Date.now());
  await store.load();
  app = AppSettingsSchema.parse({
    version: 1,
    receiverPort: 4318,
    dreaming: dreaming(),
  });
  idle = 3600;
  sessions = [task('t1')];
  fake = fakeRunner();
  deps = {
    settings: {
      get: () => app,
      save: vi.fn(async (next: AppSettings) => {
        app = next;
        return next;
      }),
    },
    store,
    runner: fake.runner,
    models: vi.fn(async () => [MODEL]),
    idleSeconds: () => idle,
    onBattery: () => false,
    agentWorking: () => false,
    repos: () => [REPO],
    sessionsOf: vi.fn(async () => sessions),
    limit: { hasRoom: () => true },
    broadcast: vi.fn(),
    now: () => Date.now(),
    git: new GitClient(),
    dreamsDir: path.join(dir, 'dreams'),
  };
  scheduler = null;
});

afterEach(() => {
  scheduler?.stop();
  vi.useRealTimers();
  cleanupTempRepos();
});

const start = (over: Partial<DreamSchedulerDeps> = {}) =>
  (scheduler = startDreamScheduler({ ...deps, ...over }));
const tick = () => vi.advanceTimersByTimeAsync(DREAM_TICK_MS);

describe('the dream scheduler', () => {
  it('checks once a minute and runs at most one dream at a time', async () => {
    start();
    await vi.advanceTimersByTimeAsync(DREAM_TICK_MS - 1);
    expect(fake.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.calls).toEqual([
      { repoId: REPO.id, signal: expect.any(AbortSignal), model: MODEL },
    ]);
    expect(deps.broadcast).toHaveBeenCalled();
    await tick();
    await tick();
    expect(fake.calls).toHaveLength(1);
    expect(scheduler!.status().wait).toBeNull();
    fake.finish({ outcome: 'nothing' });
    await tick();
    expect(fake.calls).toHaveLength(2);
  });

  it('keeps the wait, and reads no sessions while a cheaper check fails', async () => {
    app = { ...app, dreaming: dreaming({ enabled: false }) };
    start();
    await tick();
    expect(scheduler!.status().wait).toBe('off');
    expect(deps.models).not.toHaveBeenCalled();
    app = { ...app, dreaming: dreaming() };
    idle = 30;
    await tick();
    expect(fake.calls).toHaveLength(0);
    expect(scheduler!.status()).toMatchObject({
      wait: 'active',
      next: null,
      switchedOff: null,
    });
    expect(deps.sessionsOf).not.toHaveBeenCalled();
  });

  it('keeps a repo’s material for 5 minutes, and reads again once the dream store changes', async () => {
    sessions = [];
    start();
    await tick();
    expect(scheduler!.status().wait).toBe('nothing-ready');
    expect(deps.sessionsOf).toHaveBeenCalledTimes(1);
    await tick();
    await tick();
    expect(deps.sessionsOf).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * DREAM_TICK_MS);
    expect(deps.sessionsOf).toHaveBeenCalledTimes(2);
    await store.markCovered(REPO.id, { t9: 1 });
    await tick();
    expect(deps.sessionsOf).toHaveBeenCalledTimes(3);
    scheduler!.materialChanged();
    await tick();
    expect(deps.sessionsOf).toHaveBeenCalledTimes(4);
  });

  it('asks OpenCode for its models at most once every 10 minutes', async () => {
    sessions = [];
    start();
    for (let i = 0; i < 10; i++) await tick();
    expect(deps.models).toHaveBeenCalledTimes(1);
    await tick();
    expect(deps.models).toHaveBeenCalledTimes(2);
  });

  it('learns of a model removed from OpenCode within 10 minutes', async () => {
    sessions = [];
    const lists: (string[] | null)[] = [[MODEL], ['other/model']];
    start({ models: async () => lists.shift() ?? null });
    await tick();
    expect(scheduler!.status().wait).toBe('nothing-ready');
    await vi.advanceTimersByTimeAsync(10 * DREAM_TICK_MS);
    expect(scheduler!.status().wait).toBe('model-missing');
  });

  it('keeps the last good list for one more interval after a failed refresh, then knows none', async () => {
    sessions = [];
    const lists: (string[] | null)[] = [[MODEL], null, null, [MODEL]];
    start({ models: async () => lists.shift() ?? null });
    await tick();
    await vi.advanceTimersByTimeAsync(10 * DREAM_TICK_MS);
    expect(scheduler!.status().wait).toBe('nothing-ready');
    await vi.advanceTimersByTimeAsync(10 * DREAM_TICK_MS);
    expect(scheduler!.status().wait).toBe('model-missing');
    await vi.advanceTimersByTimeAsync(10 * DREAM_TICK_MS);
    expect(scheduler!.status().wait).toBe('nothing-ready');
  });

  it('gives up on a hung `opencode models` after 30 s, so Dream now still answers', async () => {
    start({ models: () => new Promise<string[] | null>(() => {}) });
    const answer = scheduler!.dreamNow(REPO.id);
    await vi.advanceTimersByTimeAsync(29_999);
    let got: unknown = null;
    void answer.then((a) => (got = a));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toEqual({ wait: 'model-missing' });
  });

  it('says what dreams next from the material it read, and checks the limit before reading', async () => {
    start({ limit: { hasRoom: () => false } });
    await tick();
    expect(scheduler!.status()).toMatchObject({
      wait: 'limit',
      next: null,
      switchedOff: null,
    });
    expect(deps.sessionsOf).not.toHaveBeenCalled();
    scheduler!.stop();
    const r2 = { id: 'r2', name: 'Api', path: '/nowhere/api' };
    app = {
      ...app,
      dreaming: dreaming({
        repos: {
          r1: { on: true, folders: ['.apm'] },
          r2: { on: true, folders: ['.apm'] },
        },
      }),
    };
    sessions = [task('t1'), task('t2')];
    start({ repos: () => [REPO, r2] });
    await tick();
    expect(fake.calls.map((c) => c.repoId)).toEqual(['r1']);
    expect(scheduler!.status().next).toEqual({ repoId: 'r2', newSessions: 2 });
    fake.finish({ outcome: 'nothing' });
    await vi.advanceTimersByTimeAsync(0);
    // What the dream changed is read again before anything is said.
    expect(scheduler!.status().next).toBeNull();
  });

  it('suspend() stops the running dream as suspend, stopDream() as stopped', async () => {
    start();
    await tick();
    scheduler!.suspend();
    expect(fake.calls[0].signal.reason).toBe('suspend');
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(fake.calls).toHaveLength(2);
    scheduler!.stopDream();
    expect(fake.calls[1].signal.reason).toBe('stopped');
    // Nothing running: both are no-ops.
    await vi.advanceTimersByTimeAsync(0);
    expect(() => scheduler!.stopDream()).not.toThrow();
    expect(deps.settings.save).not.toHaveBeenCalled();
  });

  it('quit() suspends and waits for the dream to end, never longer than asked', async () => {
    start();
    expect(scheduler!.quit(3000)).toBeNull();
    await tick();
    const done = vi.fn();
    void scheduler!.quit(3000)!.then(done);
    expect(fake.calls[0].signal.reason).toBe('suspend');
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalled();
    // A runner that does not end on the signal: quit still returns after the bound.
    const stuck: DreamSchedulerDeps['runner'] = {
      running: () => null,
      dream: () => new Promise<DreamOutcome>(() => {}),
    };
    scheduler!.stop();
    start({ runner: stuck });
    await tick();
    const late = vi.fn();
    void scheduler!.quit(3000)!.then(late);
    await vi.advanceTimersByTimeAsync(2999);
    expect(late).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(late).toHaveBeenCalled();
  });

  it('a wrong-model outcome switches dreaming off and keeps what answered, until switched on again', async () => {
    start();
    await tick();
    fake.finish({ outcome: 'wrong-model', answered: ['anthropic/claude-x'] });
    const off = {
      answered: 'anthropic/claude-x',
      chosen: MODEL,
      repoId: REPO.id,
    };
    await vi.waitFor(() =>
      expect(scheduler!.status().switchedOff).toEqual(off),
    );
    expect(app.dreaming.enabled).toBe(false);
    expect(store.switchedOff()).toEqual(off);
    expect(deps.broadcast).toHaveBeenCalled();
    await tick();
    expect(fake.calls).toHaveLength(1);
    expect(scheduler!.status().wait).toBe('off');
  });

  it('a stored switch-off wins across a restart: no dream, the save retried each check, cleared only by clearSwitchedOff()', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const off = { answered: 'a/b', chosen: MODEL, repoId: REPO.id };
    // As the last run left it: recorded, but `enabled: false` never saved.
    await store.setSwitchedOff(off);
    let failures = 2;
    const save = vi.fn(async (next: AppSettings) => {
      if (failures-- > 0) throw new Error('disk full');
      app = next;
      return next;
    });
    start({ settings: { get: () => app, save } });
    expect(await scheduler!.dreamNow(REPO.id)).toEqual({ wait: 'off' });
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
    expect(app.dreaming.enabled).toBe(true);
    await tick();
    expect(save).toHaveBeenCalledTimes(3);
    expect(app.dreaming.enabled).toBe(false);
    await tick();
    expect(save).toHaveBeenCalledTimes(3);
    expect(fake.calls).toHaveLength(0);
    expect(store.switchedOff()).toEqual(off);
    // Even with dreaming on again, only clearSwitchedOff() lets a dream start.
    app = { ...app, dreaming: { ...app.dreaming, enabled: true } };
    await tick();
    expect(fake.calls).toHaveLength(0);
    expect(store.switchedOff()).toEqual(off);
    app = { ...app, dreaming: { ...app.dreaming, enabled: true } };
    await scheduler!.clearSwitchedOff();
    await tick();
    expect(fake.calls).toHaveLength(1);
    error.mockRestore();
  });

  it('clearSwitchedOff() clears it at once', async () => {
    start();
    await tick();
    fake.finish({ outcome: 'wrong-model', answered: ['a/b'] });
    await vi.waitFor(() => expect(store.switchedOff()).not.toBeNull());
    vi.mocked(deps.broadcast).mockClear();
    await scheduler!.clearSwitchedOff();
    expect(store.switchedOff()).toBeNull();
    expect(scheduler!.status().switchedOff).toBeNull();
    expect(deps.broadcast).toHaveBeenCalled();
  });

  it('after a wrong model, a failed save is retried each check and nothing starts meanwhile, Dream now included', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failures = 2;
    const save = vi.fn(async (next: AppSettings) => {
      if (failures-- > 0) throw new Error('disk full');
      app = next;
      return next;
    });
    start({ settings: { get: () => app, save } });
    await tick();
    fake.finish({ outcome: 'wrong-model', answered: ['a/b'] });
    await vi.waitFor(() => expect(store.switchedOff()).not.toBeNull());
    expect(error).toHaveBeenCalledWith(
      '[dreams] could not switch dreaming off',
      expect.anything(),
    );
    expect(app.dreaming.enabled).toBe(true);
    expect(await scheduler!.dreamNow(REPO.id)).toEqual({ wait: 'off' });
    expect(fake.calls).toHaveLength(1);
    await tick();
    expect(app.dreaming.enabled).toBe(false);
    expect(save).toHaveBeenCalledTimes(3);
    expect(store.switchedOff()).not.toBeNull();
    expect(fake.calls).toHaveLength(1);
    error.mockRestore();
  });

  it('switchOn() clears the switch-off and saves in one step: no check runs its retry in between', async () => {
    const off = { answered: 'a/b', chosen: MODEL, repoId: REPO.id };
    await store.setSwitchedOff(off);
    app = { ...app, dreaming: { ...app.dreaming, enabled: false } };
    start();
    let release!: () => void;
    const saved = new Promise<void>((r) => (release = r));
    const on = scheduler!.switchOn(async () => {
      expect(store.switchedOff()).toBeNull();
      // A check falls due while the save is still writing.
      await tick();
      expect(deps.settings.save).not.toHaveBeenCalled();
      await saved;
      app = { ...app, dreaming: { ...app.dreaming, enabled: true } };
    });
    await vi.advanceTimersByTimeAsync(0);
    release();
    await on;
    expect(deps.settings.save).not.toHaveBeenCalled();
    await tick();
    expect(app.dreaming.enabled).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('switchOn() saves nothing when the switch-off cannot be cleared', async () => {
    await store.setSwitchedOff({
      answered: 'a/b',
      chosen: MODEL,
      repoId: REPO.id,
    });
    start();
    vi.spyOn(store, 'setSwitchedOff').mockRejectedValueOnce(
      new Error('disk full'),
    );
    const save = vi.fn(async () => undefined);
    await expect(scheduler!.switchOn(save)).rejects.toThrow('disk full');
    expect(save).not.toHaveBeenCalled();
  });

  it('status() names the running dream and the sessions it knows per repo', async () => {
    start();
    expect(scheduler!.status().running).toBeNull();
    expect(scheduler!.status().newSessions).toEqual({});
    expect(await scheduler!.dreamNow(REPO.id)).toEqual({ started: true });
    expect(scheduler!.status().running).toEqual(
      expect.objectContaining({ repoId: REPO.id, step: 'reading' }),
    );
    expect(scheduler!.status().newSessions).toEqual({ [REPO.id]: 1 });
  });

  it('a failed or interrupted outcome changes no setting', async () => {
    start();
    await tick();
    fake.finish({ outcome: 'failed', reason: 'OpenCode stopped' });
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    fake.finish({ outcome: 'interrupted', why: 'limit' });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.settings.save).not.toHaveBeenCalled();
    expect(app.dreaming.enabled).toBe(true);
  });

  it('Dream now starts while active, and says why it cannot', async () => {
    idle = 0;
    start();
    expect(await scheduler!.dreamNow(REPO.id)).toEqual({ started: true });
    expect(fake.calls).toHaveLength(1);
    expect(await scheduler!.dreamNow(REPO.id)).toEqual({ wait: 'running' });
    fake.finish({ outcome: 'nothing' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await scheduler!.dreamNow('other')).toEqual({
      wait: 'nothing-ready',
    });
    // A refused Dream now leaves the scheduler's own wait as it was.
    expect(scheduler!.status().wait).toBeNull();
  });
});

describe('sweep', () => {
  it('removes every dream folder and dream branch no open result refers to, and nothing else', async () => {
    vi.useRealTimers();
    const repo = makeRepo();
    const root = path.dirname(repo);
    const dreamsDir = path.join(root, 'userdata', 'dreams');
    const repoDir = path.join(dreamsDir, REPO.id);
    // The open result: its folder (with its worktree) and branch stay.
    const kept = path.join(repoDir, '2026-11-19-1');
    mkdirSync(kept, { recursive: true });
    git(
      repo,
      'worktree',
      'add',
      '-q',
      '-b',
      'dream/2026-11-19-1',
      path.join(kept, 'wt'),
    );
    // A dream that was interrupted by a crash: folder, worktree and branch go.
    const stray = path.join(repoDir, '2026-11-19-2');
    mkdirSync(stray, { recursive: true });
    git(
      repo,
      'worktree',
      'add',
      '-q',
      '-b',
      'dream/2026-11-19-2',
      path.join(stray, 'wt'),
    );
    mkdirSync(path.join(stray, 'data'));
    // A dream branch is a dream's leftover only with its folder: without one it is the owner's (a dream opened as
    // a task), and so is any other name under dream/.
    git(repo, 'branch', 'dream/2026-11-20-1');
    // A leftover folder (its worktree gone already) and its branch: both go.
    mkdirSync(path.join(repoDir, '2026-11-20-2', 'data'), { recursive: true });
    git(repo, 'branch', 'dream/2026-11-20-2');
    git(repo, 'branch', 'dream/my-idea');
    // A leftover folder whose branch the owner checked out as a task: the folder goes, the branch stays.
    mkdirSync(path.join(repoDir, '2026-11-17-1'), { recursive: true });
    git(repo, 'branch', 'dream/2026-11-17-1');
    const taskWt = path.join(root, 'task-wt');
    git(repo, 'worktree', 'add', '-q', taskWt, 'dream/2026-11-17-1');
    git(repo, 'branch', 'feature/x');
    // Folders of a repo Shellie no longer knows go; a file at the top stays.
    mkdirSync(path.join(dreamsDir, 'gone', '2026-11-01-1'), {
      recursive: true,
    });
    writeFileSync(path.join(dreamsDir, 'note.txt'), 'x');
    writeFileSync(path.join(root, 'outside.txt'), 'x');

    const result: DreamResult = {
      id: '2026-11-19-1',
      repoId: REPO.id,
      branch: 'dream/2026-11-19-1',
      baseSha: 'abc',
      worktreePath: path.join(kept, 'wt'),
      dataDir: path.join(kept, 'data'),
      at: new Date(NOW).toISOString(),
      model: MODEL,
      tokens: 0,
      sessions: 1,
      proposals: [],
      reverted: [],
      removedByCheck: 0,
    };
    await store.setResult(REPO.id, result);
    const s = startDreamScheduler({
      ...deps,
      repos: () => [{ ...REPO, path: repo }],
      dreamsDir,
      now: Date.now,
    });
    scheduler = s;
    await s.sweep();

    const branches = git(
      repo,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/',
    )
      .trim()
      .split('\n')
      .sort();
    expect(branches).toEqual([
      'dream/2026-11-17-1',
      'dream/2026-11-19-1',
      'dream/2026-11-20-1',
      'dream/my-idea',
      'feature/x',
      'main',
    ]);
    expect(existsSync(path.join(repoDir, '2026-11-17-1'))).toBe(false);
    expect(existsSync(path.join(repoDir, '2026-11-20-2'))).toBe(false);
    expect(existsSync(path.join(kept, 'wt'))).toBe(true);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(path.join(dreamsDir, 'gone', '2026-11-01-1'))).toBe(
      false,
    );
    expect(existsSync(path.join(dreamsDir, 'note.txt'))).toBe(true);
    expect(existsSync(path.join(root, 'outside.txt'))).toBe(true);
    expect(existsSync(taskWt)).toBe(true);
    // Its own empty hooks folder is gone again.
    expect((await import('node:fs')).readdirSync(dreamsDir).sort()).toEqual([
      'gone',
      'note.txt',
      REPO.id,
    ]);
    const worktrees = git(repo, 'worktree', 'list', '--porcelain');
    expect(worktrees).not.toContain('2026-11-19-2');
  });

  it('skips a repo that is no longer on disk, quietly', async () => {
    vi.useRealTimers();
    const dreamsDir = path.join(dir, 'dreams');
    const left = path.join(dreamsDir, REPO.id, '2026-11-19-2');
    mkdirSync(left, { recursive: true });
    const error = vi.spyOn(console, 'error');
    const s = startDreamScheduler({ ...deps, dreamsDir, now: Date.now });
    scheduler = s;
    await s.sweep();
    expect(existsSync(left)).toBe(true);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
