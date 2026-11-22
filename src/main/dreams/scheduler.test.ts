import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DreamResult,
  DreamingAll,
  DreamingSettings,
} from '../../shared/dreams';
import { AppSettingsSchema, type AppSettings } from '../../shared/usage';
import { GitClient } from '../services/GitClient';
import { cleanupTempRepos, git, makeRepo } from '../test-helpers/gitRepo';
import type { DreamOutcome } from './DreamRunner';
import { DreamStore } from './DreamStore';
import { opencodeModelList } from './models';
import type { TaskSessions } from './material';
import {
  DREAM_TICK_MS,
  startDreamScheduler,
  type DreamSchedulerDeps,
} from './scheduler';

const MODEL = 'zai/glm-5';
const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();
/** The one project most tests are about. */
const P = 'p1';
const REPO = {
  id: 'r1',
  name: 'Portal',
  path: '/nowhere/portal',
  connectionId: P as string | null,
};

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
  const projects: string[] = [];
  let settle: ((o: DreamOutcome) => void) | null = null;
  let current: {
    repoId: string;
    project: string;
    startedAt: number;
    step: 'reading';
  } | null = null;
  const runner: DreamSchedulerDeps['runner'] = {
    running: () => current,
    dream: (repo, o) => {
      calls.push({ repoId: repo.id, signal: o.signal, model: o.model });
      projects.push(o.project);
      current = {
        repoId: repo.id,
        project: o.project,
        startedAt: Date.now(),
        step: 'reading',
      };
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
    projects,
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
/** `opencode models`, as the shared list asks it. */
let ask: ReturnType<typeof vi.fn<() => Promise<string[] | null>>>;
const listOf = (a: () => Promise<string[] | null>) =>
  opencodeModelList({ ask: a, now: () => Date.now() });
let scheduler: ReturnType<typeof startDreamScheduler> | null;
/** The block of project `P`, as the tests of one project read and write it. */
const block = (): DreamingSettings => app.dreaming.projects[P];
const setBlock = (b: DreamingSettings, project = P) => {
  app = {
    ...app,
    dreaming: {
      ...app.dreaming,
      projects: { ...app.dreaming.projects, [project]: b },
    },
  };
};

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW });
  dir = mkdtempSync(path.join(tmpdir(), 'dream-sched-'));
  store = new DreamStore(dir, () => Date.now());
  await store.load();
  app = AppSettingsSchema.parse({
    version: 1,
    receiverPort: 4318,
    dreaming: { projects: { [P]: dreaming() } },
  });
  idle = 3600;
  sessions = [task('t1')];
  fake = fakeRunner();
  ask = vi.fn(async () => [MODEL]);
  deps = {
    settings: {
      get: () => app,
      updateDreaming: vi.fn(async (fn: (d: DreamingAll) => DreamingAll) => {
        app = { ...app, dreaming: fn(app.dreaming) };
        return app;
      }),
    },
    store,
    runner: fake.runner,
    models: listOf(() => ask()),
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
    expect(scheduler!.status(P).wait).toBeNull();
    fake.finish({ outcome: 'nothing' });
    await tick();
    expect(fake.calls).toHaveLength(2);
  });

  it('keeps the wait, and reads no sessions while a cheaper check fails', async () => {
    setBlock(dreaming({ enabled: false }));
    start();
    await tick();
    expect(scheduler!.status(P).wait).toBe('off');
    expect(ask).not.toHaveBeenCalled();
    setBlock(dreaming());
    idle = 30;
    await tick();
    expect(fake.calls).toHaveLength(0);
    expect(scheduler!.status(P)).toMatchObject({
      wait: 'active',
      next: null,
      switchedOff: null,
    });
    expect(deps.sessionsOf).not.toHaveBeenCalled();
  });

  it('keeps a repo’s material until something can change it, at most 60 minutes', async () => {
    sessions = [];
    start();
    await tick();
    expect(scheduler!.status(P).wait).toBe('nothing-ready');
    expect(deps.sessionsOf).toHaveBeenCalledTimes(1);
    // Idle all night with nothing new: not read again every few minutes.
    await vi.advanceTimersByTimeAsync(58 * DREAM_TICK_MS);
    expect(deps.sessionsOf).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * DREAM_TICK_MS);
    expect(deps.sessionsOf).toHaveBeenCalledTimes(2);
    await store.markCovered(REPO.id, { t9: 1 });
    await tick();
    expect(deps.sessionsOf).toHaveBeenCalledTimes(3);
    scheduler!.materialChanged();
    await tick();
    expect(deps.sessionsOf).toHaveBeenCalledTimes(4);
    // An agent tab of another repo's task reported: this repo's answer stands.
    scheduler!.materialChanged('other');
    await tick();
    expect(deps.sessionsOf).toHaveBeenCalledTimes(4);
    scheduler!.materialChanged(REPO.id);
    await tick();
    expect(deps.sessionsOf).toHaveBeenCalledTimes(5);
  });

  it('asks for the sessions with the repo’s covered marks, so unchanged tasks need not be read', async () => {
    sessions = [];
    await store.markCovered(REPO.id, { t1: 5 });
    start();
    await tick();
    expect(deps.sessionsOf).toHaveBeenCalledWith(REPO.id, { t1: 5 });
  });

  it('asks OpenCode for its models at most once every 10 minutes', async () => {
    sessions = [];
    start();
    for (let i = 0; i < 10; i++) await tick();
    expect(ask).toHaveBeenCalledTimes(1);
    await tick();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('asks for the models only once the cheap checks pass: not while the owner is active', async () => {
    sessions = [];
    idle = 30;
    start();
    for (let i = 0; i < 15; i++) await tick();
    expect(ask).not.toHaveBeenCalled();
    expect(scheduler!.status(P).wait).toBe('active');
    idle = 3600;
    await tick();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(scheduler!.status(P).wait).toBe('nothing-ready');
  });

  it('nor while an agent works, on battery, or while a dream runs', async () => {
    let busy = true;
    let battery = false;
    start({ agentWorking: () => busy, onBattery: () => battery });
    await tick();
    expect(scheduler!.status(P).wait).toBe('agents-busy');
    busy = false;
    battery = true;
    await tick();
    expect(scheduler!.status(P).wait).toBe('battery');
    expect(ask).not.toHaveBeenCalled();
  });

  it('says the model is missing before it says the owner is active, for a list it already knows', async () => {
    const list = listOf(async () => ['other/model']);
    await list.get();
    idle = 30;
    start({ models: list });
    await tick();
    expect(scheduler!.status(P).wait).toBe('model-missing');
  });

  it('caches a failed ask for 10 minutes', async () => {
    sessions = [];
    ask.mockResolvedValue(null);
    start();
    for (let i = 0; i < 10; i++) await tick();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(scheduler!.status(P).wait).toBe('model-missing');
    await tick();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('learns of a model removed from OpenCode within 10 minutes', async () => {
    sessions = [];
    const lists: (string[] | null)[] = [[MODEL], ['other/model']];
    start({ models: listOf(async () => lists.shift() ?? null) });
    await tick();
    expect(scheduler!.status(P).wait).toBe('nothing-ready');
    await vi.advanceTimersByTimeAsync(10 * DREAM_TICK_MS);
    expect(scheduler!.status(P).wait).toBe('model-missing');
  });

  it('keeps the last good list for one more interval after a failed refresh, then knows none', async () => {
    sessions = [];
    const lists: (string[] | null)[] = [[MODEL], null, null, [MODEL]];
    start({ models: listOf(async () => lists.shift() ?? null) });
    await tick();
    await vi.advanceTimersByTimeAsync(10 * DREAM_TICK_MS);
    expect(scheduler!.status(P).wait).toBe('nothing-ready');
    await vi.advanceTimersByTimeAsync(10 * DREAM_TICK_MS);
    expect(scheduler!.status(P).wait).toBe('model-missing');
    await vi.advanceTimersByTimeAsync(10 * DREAM_TICK_MS);
    expect(scheduler!.status(P).wait).toBe('nothing-ready');
  });

  it('gives up on a hung `opencode models` after 30 s, so Dream now still answers', async () => {
    start({ models: listOf(() => new Promise<string[] | null>(() => {})) });
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
    expect(scheduler!.status(P)).toMatchObject({
      wait: 'limit',
      next: null,
      switchedOff: null,
    });
    expect(deps.sessionsOf).not.toHaveBeenCalled();
    scheduler!.stop();
    const r2 = { id: 'r2', name: 'Api', path: '/nowhere/api', connectionId: P };
    setBlock(
      dreaming({
        repos: {
          r1: { on: true, folders: ['.apm'] },
          r2: { on: true, folders: ['.apm'] },
        },
      }),
    );
    sessions = [task('t1'), task('t2')];
    start({ repos: () => [REPO, r2] });
    await tick();
    expect(fake.calls.map((c) => c.repoId)).toEqual(['r1']);
    expect(scheduler!.status(P).next).toEqual({ repoId: 'r2', newSessions: 2 });
    fake.finish({ outcome: 'nothing' });
    await vi.advanceTimersByTimeAsync(0);
    // What the dream changed is read again before anything is said.
    expect(scheduler!.status(P).next).toBeNull();
  });

  it('suspend() stops the running dream as suspend, stopDream() as stopped', async () => {
    start();
    await tick();
    scheduler!.suspend();
    expect(fake.calls[0].signal.reason).toBe('suspend');
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(fake.calls).toHaveLength(2);
    scheduler!.stopDream(P);
    expect(fake.calls[1].signal.reason).toBe('stopped');
    // Nothing running: both are no-ops.
    await vi.advanceTimersByTimeAsync(0);
    expect(() => scheduler!.stopDream(P)).not.toThrow();
    expect(deps.settings.updateDreaming).not.toHaveBeenCalled();
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
      expect(scheduler!.status(P).switchedOff).toEqual(off),
    );
    expect(block().enabled).toBe(false);
    // The passed test no longer counts: switching on again needs a new one.
    expect(block().testedModel).toBeNull();
    expect(block().model).toBe(MODEL);
    expect(store.switchedOff(P)).toEqual(off);
    expect(deps.broadcast).toHaveBeenCalled();
    await tick();
    expect(fake.calls).toHaveLength(1);
    expect(scheduler!.status(P).wait).toBe('off');
  });

  it('a stored switch-off wins across a restart: no dream, the save retried each check, cleared only by switchOn()', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const off = { answered: 'a/b', chosen: MODEL, repoId: REPO.id };
    // As the last run left it: recorded, but `enabled: false` never saved.
    await store.setSwitchedOff(P, off);
    let failures = 2;
    const save = vi.fn(async (fn: (d: DreamingAll) => DreamingAll) => {
      if (failures-- > 0) throw new Error('disk full');
      app = { ...app, dreaming: fn(app.dreaming) };
      return app;
    });
    start({ settings: { get: () => app, updateDreaming: save } });
    expect(await scheduler!.dreamNow(REPO.id)).toEqual({ wait: 'off' });
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
    expect(block().enabled).toBe(true);
    await tick();
    expect(save).toHaveBeenCalledTimes(3);
    expect(block().enabled).toBe(false);
    // The retried write clears the passed test too.
    expect(block().testedModel).toBeNull();
    await tick();
    expect(save).toHaveBeenCalledTimes(3);
    expect(fake.calls).toHaveLength(0);
    expect(store.switchedOff(P)).toEqual(off);
    // Even with dreaming on again, only switchOn() lets a dream start.
    setBlock({ ...block(), enabled: true });
    await tick();
    expect(fake.calls).toHaveLength(0);
    expect(store.switchedOff(P)).toEqual(off);
    await scheduler!.switchOn(P, async () => {
      setBlock({ ...block(), enabled: true });
    });
    await tick();
    expect(fake.calls).toHaveLength(1);
    error.mockRestore();
  });

  it('tells the screens when a check finds a new reason to wait, and only then', async () => {
    idle = 0;
    start();
    await tick();
    expect(scheduler!.status(P).wait).toBe('active');
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
    await tick();
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
    deps.limit.hasRoom = () => false;
    idle = 3600;
    await tick();
    expect(scheduler!.status(P).wait).toBe('limit');
    expect(deps.broadcast).toHaveBeenCalledTimes(2);
  });

  it('switchOn() forgets the wait of a check made while dreaming was off', async () => {
    setBlock(dreaming({ enabled: false }));
    start();
    await tick();
    expect(scheduler!.status(P).wait).toBe('off');
    await scheduler!.switchOn(P, async () => {
      setBlock(dreaming());
    });
    // Until the next check: no reason to wait is known, rather than "Dreams are off".
    expect(scheduler!.status(P).wait).toBeNull();
  });

  it('switchOn() ends a switch-off at once', async () => {
    start();
    await tick();
    fake.finish({ outcome: 'wrong-model', answered: ['a/b'] });
    await vi.waitFor(() => expect(store.switchedOff(P)).not.toBeNull());
    await scheduler!.switchOn(P, async () => undefined);
    expect(store.switchedOff(P)).toBeNull();
    expect(scheduler!.status(P).switchedOff).toBeNull();
  });

  it('after a wrong model, a failed save is retried each check and nothing starts meanwhile, Dream now included', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failures = 2;
    const save = vi.fn(async (fn: (d: DreamingAll) => DreamingAll) => {
      if (failures-- > 0) throw new Error('disk full');
      app = { ...app, dreaming: fn(app.dreaming) };
      return app;
    });
    start({ settings: { get: () => app, updateDreaming: save } });
    await tick();
    fake.finish({ outcome: 'wrong-model', answered: ['a/b'] });
    await vi.waitFor(() => expect(store.switchedOff(P)).not.toBeNull());
    expect(error).toHaveBeenCalledWith(
      '[dreams] could not switch dreaming off',
      expect.anything(),
    );
    expect(block().enabled).toBe(true);
    expect(await scheduler!.dreamNow(REPO.id)).toEqual({ wait: 'off' });
    expect(fake.calls).toHaveLength(1);
    await tick();
    expect(block().enabled).toBe(false);
    expect(save).toHaveBeenCalledTimes(3);
    expect(store.switchedOff(P)).not.toBeNull();
    expect(fake.calls).toHaveLength(1);
    error.mockRestore();
  });

  it('switchOn() saves, then clears the switch-off, in one step: no check runs its retry in between', async () => {
    const off = { answered: 'a/b', chosen: MODEL, repoId: REPO.id };
    await store.setSwitchedOff(P, off);
    setBlock({ ...block(), enabled: false });
    start();
    let release!: () => void;
    const saved = new Promise<void>((r) => (release = r));
    const on = scheduler!.switchOn(P, async () => {
      // Cleared only once the save went through.
      expect(store.switchedOff(P)).toEqual(off);
      // A check falls due while the save is still writing.
      await tick();
      expect(deps.settings.updateDreaming).not.toHaveBeenCalled();
      await saved;
      setBlock({ ...block(), enabled: true });
    });
    await vi.advanceTimersByTimeAsync(0);
    release();
    await on;
    expect(deps.settings.updateDreaming).not.toHaveBeenCalled();
    await tick();
    expect(block().enabled).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('switchOn() keeps the switch-off record when its save throws', async () => {
    const off = { answered: 'a/b', chosen: MODEL, repoId: REPO.id };
    await store.setSwitchedOff(P, off);
    start();
    await expect(
      scheduler!.switchOn(P, async () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
    expect(store.switchedOff(P)).toEqual(off);
    await tick();
    expect(fake.calls).toHaveLength(0);
  });

  it('switchOn() that saved but could not clear the record leaves the switch-off in force', async () => {
    const off = { answered: 'a/b', chosen: MODEL, repoId: REPO.id };
    await store.setSwitchedOff(P, off);
    start();
    vi.spyOn(store, 'setSwitchedOff').mockRejectedValueOnce(
      new Error('disk full'),
    );
    await expect(
      scheduler!.switchOn(P, async () => {
        setBlock({ ...block(), enabled: true });
      }),
    ).rejects.toThrow('disk full');
    await tick();
    expect(block().enabled).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('status() names the running dream and the sessions it knows per repo', async () => {
    start();
    expect(scheduler!.status(P).running).toBeNull();
    expect(scheduler!.status(P).newSessions).toEqual({});
    expect(await scheduler!.dreamNow(REPO.id)).toEqual({ started: true });
    expect(scheduler!.status(P).running).toEqual(
      expect.objectContaining({ repoId: REPO.id, step: 'reading' }),
    );
    expect(scheduler!.status(P).newSessions).toEqual({ [REPO.id]: 1 });
  });

  it('a failed or interrupted outcome changes no setting', async () => {
    start();
    await tick();
    fake.finish({ outcome: 'failed', reason: 'OpenCode stopped' });
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    fake.finish({ outcome: 'interrupted', why: 'limit' });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.settings.updateDreaming).not.toHaveBeenCalled();
    expect(block().enabled).toBe(true);
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
    expect(scheduler!.status(P).wait).toBeNull();
  });
});

describe('several projects', () => {
  const Q = 'p2';
  const R = 'p3';
  const repoOf = (id: string, project: string | null) => ({
    id,
    name: id,
    path: `/nowhere/${id}`,
    connectionId: project,
  });
  const blockFor = (repoId: string, over: Partial<DreamingSettings> = {}) =>
    dreaming({ repos: { [repoId]: { on: true, folders: ['.apm'] } }, ...over });
  it('one dream at a time: the project that dreamt longest ago goes first, the other waits', async () => {
    setBlock(blockFor('r2'), Q);
    // Project P dreamt a moment ago; Q never did.
    await store.succeeded('r1', 'nothing');
    start({ repos: () => [REPO, repoOf('r2', Q)] });
    await vi.advanceTimersByTimeAsync(DREAM_TICK_MS);
    expect(fake.calls).toHaveLength(1);
    const first = fake.calls[0].repoId;
    expect(first).toBe('r2');
    const [mine, other] = [Q, P];
    expect(scheduler!.status(mine).wait).toBeNull();
    expect(scheduler!.status(mine).running?.repoId).toBe(first);
    // The other project sees only that a dream runs elsewhere.
    expect(scheduler!.status(other)).toMatchObject({
      wait: 'running-elsewhere',
      running: null,
    });
  });

  it('each project waits for its own idle minutes and its own limit', async () => {
    setBlock(blockFor('r1', { idleMinutes: 120 }));
    setBlock(blockFor('r2', { idleMinutes: 10 }), Q);
    setBlock(blockFor('r3'), R);
    idle = 3600;
    start({
      repos: () => [REPO, repoOf('r2', Q), repoOf('r3', R)],
      limit: { hasRoom: (project) => project !== R },
    });
    await vi.advanceTimersByTimeAsync(DREAM_TICK_MS);
    expect(fake.calls.map((c) => c.repoId)).toEqual(['r2']);
    fake.finish({ outcome: 'nothing' });
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler!.status(P).wait).toBe('active');
    expect(scheduler!.status(R).wait).toBe('limit');
  });

  it('a repo dreams for its own project only: one moved away, or without a project, never starts', async () => {
    setBlock(
      dreaming({
        repos: {
          r2: { on: true, folders: ['.apm'] },
          loose: { on: true, folders: ['.apm'] },
        },
      }),
    );
    start({ repos: () => [repoOf('r2', Q), repoOf('loose', null)] });
    await vi.advanceTimersByTimeAsync(DREAM_TICK_MS);
    expect(fake.calls).toHaveLength(0);
    expect(scheduler!.status(P).wait).toBe('nothing-ready');
    expect(await scheduler!.dreamNow('loose')).toEqual({
      wait: 'nothing-ready',
    });
  });

  it('another model answering switches off every project on that model, each with its own record, and no other', async () => {
    setBlock(blockFor('r2'), Q);
    setBlock(
      blockFor('r3', { model: 'zai/other', testedModel: 'zai/other' }),
      R,
    );
    ask = vi.fn(async () => [MODEL, 'zai/other']);
    // Only project P is ready to dream.
    sessions = [task('t1')];
    start({
      repos: () => [REPO, repoOf('r2', Q), repoOf('r3', R)],
      sessionsOf: vi.fn(async (repoId: string) =>
        repoId === 'r1' ? sessions : [],
      ),
    });
    await vi.advanceTimersByTimeAsync(DREAM_TICK_MS);
    expect(fake.calls.map((c) => c.repoId)).toEqual(['r1']);
    fake.finish({ outcome: 'wrong-model', answered: ['x/y'] });
    const off = { answered: 'x/y', chosen: MODEL, repoId: 'r1' };
    await vi.waitFor(() => expect(store.switchedOff(Q)).toEqual(off));
    expect(store.switchedOff(P)).toEqual(off);
    expect(store.switchedOff(R)).toBeNull();
    await vi.waitFor(() =>
      expect(app.dreaming.projects[Q].enabled).toBe(false),
    );
    expect(app.dreaming.projects[P]).toMatchObject({
      enabled: false,
      testedModel: null,
    });
    expect(app.dreaming.projects[Q].testedModel).toBeNull();
    expect(app.dreaming.projects[R]).toMatchObject({
      enabled: true,
      testedModel: 'zai/other',
    });
    // Switching one project on again leaves the other off.
    await scheduler!.switchOn(P, async () => undefined);
    expect(store.switchedOff(P)).toBeNull();
    expect(store.switchedOff(Q)).toEqual(off);
  });

  it('switchOffModel() records and saves off every project on the model in one write, stops its dream and says so once', async () => {
    const event = vi.fn();
    setBlock(blockFor('r2'), Q);
    setBlock(
      blockFor('r3', { model: 'zai/other', testedModel: 'zai/other' }),
      R,
    );
    start({ repos: () => [REPO, repoOf('r2', Q), repoOf('r3', R)], event });
    expect(await scheduler!.dreamNow('r1')).toEqual({ started: true });
    vi.mocked(deps.settings.updateDreaming).mockClear();
    await scheduler!.switchOffModel({
      project: Q,
      model: MODEL,
      answered: 'x/y',
      repoId: '',
    });
    const off = { answered: 'x/y', chosen: MODEL, repoId: '' };
    expect(store.switchedOff(P)).toEqual(off);
    expect(store.switchedOff(Q)).toEqual(off);
    expect(store.switchedOff(R)).toBeNull();
    expect(deps.settings.updateDreaming).toHaveBeenCalledOnce();
    for (const p of [P, Q])
      expect(app.dreaming.projects[p]).toMatchObject({
        enabled: false,
        testedModel: null,
      });
    expect(app.dreaming.projects[R]).toMatchObject({
      enabled: true,
      testedModel: 'zai/other',
    });
    expect(fake.calls[0].signal.aborted).toBe(true);
    expect(
      event.mock.calls.filter(([name]) => name === 'dream.switched_off'),
    ).toEqual([['dream.switched_off', { by: 'wrong-model' }]]);
  });

  it('switchOffModel() sends no dream.switched_off when every affected project is already off', async () => {
    const event = vi.fn();
    setBlock({ ...block(), enabled: false });
    start({ event });
    await scheduler!.switchOffModel({
      project: P,
      model: MODEL,
      answered: 'x/y',
      repoId: '',
    });
    expect(store.switchedOff(P)).toEqual({
      answered: 'x/y',
      chosen: MODEL,
      repoId: '',
    });
    expect(
      event.mock.calls.filter(([name]) => name === 'dream.switched_off'),
    ).toEqual([]);
  });

  it('switchOffModel() keeps a project off until quit when its record cannot be written', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'setSwitchedOff').mockRejectedValue(new Error('disk'));
    start();
    await scheduler!.switchOffModel({
      project: P,
      model: MODEL,
      answered: 'x/y',
      repoId: '',
    });
    expect(store.switchedOff(P)).toBeNull();
    expect(block().enabled).toBe(false);
    // Switched on behind its back: the switch-off still holds.
    setBlock({ ...block(), enabled: true, testedModel: MODEL });
    expect(await scheduler!.dreamNow(REPO.id)).toEqual({ wait: 'off' });
    expect(fake.calls).toHaveLength(0);
    expect(block().enabled).toBe(false);
    error.mockRestore();
  });

  it('Stop stops only the project\u2019s own dream', async () => {
    setBlock(blockFor('r2'), Q);
    start({ repos: () => [REPO, repoOf('r2', Q)] });
    expect(await scheduler!.dreamNow('r1')).toEqual({ started: true });
    scheduler!.stopDream(Q);
    expect(fake.calls[0].signal.aborted).toBe(false);
    scheduler!.stopDream(P);
    expect(fake.calls[0].signal.aborted).toBe(true);
  });

  it('a dream stays its project\u2019s when its repo is linked to another project meanwhile', async () => {
    setBlock(blockFor('r2'), Q);
    let home: string = P;
    start({ repos: () => [{ ...REPO, connectionId: home }, repoOf('r2', Q)] });
    await scheduler!.dreamNow('r1');
    home = Q;
    expect(scheduler!.runningDream()).toEqual({ repoId: 'r1', project: P });
    expect(scheduler!.status(P).running?.repoId).toBe('r1');
    // The other project sees no dream of its own, and its Stop does nothing.
    expect(scheduler!.status(Q)).toMatchObject({
      running: null,
      wait: 'running-elsewhere',
    });
    scheduler!.stopDream(Q);
    expect(fake.calls[0].signal.aborted).toBe(false);
  });

  it('does not start a dream of a project that was switched off while the check was reading', async () => {
    const reading = vi.fn(async () => {
      // As `dream:switchOff` landing while the sessions are read.
      setBlock({ ...block(), enabled: false });
      return sessions;
    });
    start({ sessionsOf: reading });
    await vi.advanceTimersByTimeAsync(DREAM_TICK_MS);
    expect(reading).toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it('the dream carries its project, for the title of its sessions', async () => {
    start();
    await scheduler!.dreamNow('r1');
    expect(fake.projects).toEqual([P]);
  });
});

describe('telemetry', () => {
  const events = () =>
    vi.mocked(deps.event!).mock.calls as [string, Record<string, unknown>][];
  const OUTCOMES = new Set([
    'proposed',
    'nothing',
    'interrupted',
    'limit',
    'wrong-model',
    'failed',
  ]);
  /** The keys, and the value types: an outcome from the fixed list and counts. Never a model, repo or path. */
  const safeRun = (p: Record<string, unknown>) => {
    expect(Object.keys(p).sort()).toEqual(
      ['droppedByCheck', 'ms', 'outcome', 'proposals'].sort(),
    );
    expect(OUTCOMES.has(p.outcome as string)).toBe(true);
    expect(typeof p.ms).toBe('number');
    expect(typeof p.proposals).toBe('number');
    expect(typeof p.droppedByCheck).toBe('number');
  };
  const result = (): DreamResult => ({
    id: '2026-11-20-1',
    repoId: REPO.id,
    branch: 'dream/2026-11-20-1',
    baseSha: 'a'.repeat(40),
    worktreePath: '/x/wt',
    dataDir: '/x/data',
    at: new Date(NOW).toISOString(),
    model: MODEL,
    tokens: 5,
    sessions: 1,
    proposals: [1, 2].map((i) => ({
      id: `p${i}`,
      kind: 'new-rule' as const,
      title: `Rule ${i}`,
      why: 'why',
      evidence: [],
      files: [`.apm/rules/${i}.md`],
      commit: 'b'.repeat(40),
      dropped: false,
    })),
    reverted: [],
    removedByCheck: 1,
  });

  beforeEach(() => {
    deps.event = vi.fn();
  });

  it('dream.run carries the outcome, how long it took, the proposals and what the check removed', async () => {
    start();
    await tick();
    await vi.advanceTimersByTimeAsync(90_000);
    fake.finish({ outcome: 'proposed', result: result() });
    await vi.waitFor(() => expect(events()).toHaveLength(1));
    const [name, props] = events()[0];
    expect(name).toBe('dream.run');
    expect(props).toEqual({
      outcome: 'proposed',
      ms: expect.any(Number),
      proposals: 2,
      droppedByCheck: 1,
    });
    // vi.waitFor moves the fake clock on a little while it waits.
    expect(props.ms).toBeGreaterThanOrEqual(90_000);
    expect(props.ms).toBeLessThan(91_000);
    safeRun(props);
  });

  it('dream.run says limit for a dream the day’s limit interrupted, and takes counts from its journal line', async () => {
    start();
    await tick();
    await store.log({
      dreamId: '2026-11-20-1',
      repoId: REPO.id,
      at: new Date(Date.now()).toISOString(),
      model: MODEL,
      tokens: 9,
      outcome: 'nothing',
      reason: null,
      proposals: 0,
      removedByCheck: 3,
      closed: null,
    });
    fake.finish({ outcome: 'nothing' });
    await vi.waitFor(() => expect(events()).toHaveLength(1));
    expect(events()[0][1]).toMatchObject({
      outcome: 'nothing',
      droppedByCheck: 3,
    });
    await tick();
    fake.finish({ outcome: 'interrupted', why: 'limit' });
    await vi.waitFor(() => expect(events()).toHaveLength(2));
    expect(events()[1][1]).toMatchObject({ outcome: 'limit' });
    events().forEach(([, p]) => safeRun(p));
  });

  it('a wrong model sends dream.run and dream.switched_off by wrong-model, never the model', async () => {
    start();
    await tick();
    fake.finish({ outcome: 'wrong-model', answered: ['anthropic/claude-x'] });
    await vi.waitFor(() => expect(events()).toHaveLength(2));
    expect(
      events()
        .map(([n]) => n)
        .sort(),
    ).toEqual(['dream.run', 'dream.switched_off']);
    expect(events().find(([n]) => n === 'dream.switched_off')![1]).toEqual({
      by: 'wrong-model',
    });
    expect(JSON.stringify(events())).not.toMatch(/claude|zai|glm|Portal|r1/);
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
    // A result opened as a task and not made into one yet: no folder, its branch stays.
    git(repo, 'branch', 'dream/2026-11-18-1');
    await store.setOpened(REPO.id, {
      dreamId: '2026-11-18-1',
      branch: 'dream/2026-11-18-1',
      at: new Date(NOW).toISOString(),
      kept: 1,
      titles: ['A rule'],
    });
    // State of a repo Shellie no longer knows is forgotten.
    await store.failed('gone', 'x');
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
      'dream/2026-11-18-1',
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
    expect(existsSync(path.join(dreamsDir, 'gone'))).toBe(false);
    expect(store.repoIds()).toEqual([REPO.id]);
    expect(store.repo(REPO.id).opened).not.toBeNull();
    expect(existsSync(path.join(dreamsDir, 'note.txt'))).toBe(true);
    expect(existsSync(path.join(root, 'outside.txt'))).toBe(true);
    expect(existsSync(taskWt)).toBe(true);
    // Its own empty hooks folder is gone again.
    expect((await import('node:fs')).readdirSync(dreamsDir).sort()).toEqual([
      'note.txt',
      REPO.id,
    ]);
    const worktrees = git(repo, 'worktree', 'list', '--porcelain');
    expect(worktrees).not.toContain('2026-11-19-2');
  });

  it('removes a test call’s folder a crash left, whole, and never takes it for a repo', async () => {
    vi.useRealTimers();
    const dreamsDir = path.join(dir, 'dreams');
    const left = path.join(dreamsDir, '.test-abc123');
    mkdirSync(path.join(left, 'wt'), { recursive: true });
    mkdirSync(path.join(left, 'data'));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(left, old, old);
    // A test that runs while Shellie starts is left alone.
    const live = path.join(dreamsDir, '.test-live');
    mkdirSync(path.join(live, 'wt'), { recursive: true });
    const s = startDreamScheduler({ ...deps, dreamsDir, now: Date.now });
    scheduler = s;
    await s.sweep();
    expect(existsSync(left)).toBe(false);
    expect(existsSync(path.join(live, 'wt'))).toBe(true);
    expect(readdirSync(dreamsDir)).toEqual(['.test-live']);
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
