import { describe, expect, it } from 'vitest';
import {
  defaultDreaming,
  type DreamingSettings,
  type DreamRepoState,
  type DreamResult,
} from '../../shared/dreams';
import { backoffUntil, nextDream, type ReadyInput } from './ready';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const H = 3600_000;
const MODEL = 'zai/glm-5';

const state = (over: Partial<DreamRepoState> = {}): DreamRepoState => ({
  covered: {},
  sightings: [],
  rejections: [],
  failures: 0,
  lastFailureAt: null,
  lastFailure: null,
  lastDreamAt: null,
  lastOutcome: null,
  result: null,
  ...over,
});

const result = { id: 'r' } as DreamResult;

const settings = (over: Partial<DreamingSettings> = {}): DreamingSettings => ({
  ...defaultDreaming(),
  enabled: true,
  model: MODEL,
  testedModel: MODEL,
  limit: { kind: 'none' },
  repos: {
    a: { on: true, folders: ['.apm'] },
    b: { on: true, folders: ['.apm'] },
  },
  ...over,
});

type Repo = ReadyInput['repos'][number];
const repo = (id: string, over: Partial<Repo> = {}): Repo => ({
  id,
  state: state(),
  hasMaterial: true,
  newestMaterialAt: NOW - H,
  ...over,
});

const input = (over: Partial<ReadyInput> = {}): ReadyInput => ({
  settings: settings(),
  models: [MODEL, 'other/model'],
  idleSeconds: 3600,
  onBattery: false,
  agentWorking: false,
  running: false,
  overLimit: false,
  now: NOW,
  repos: [repo('a')],
  ...over,
});

describe('nextDream', () => {
  it('picks a ready repo when every check holds', () => {
    expect(nextDream(input())).toEqual({ repoId: 'a' });
  });

  it('gives each wait in the order of the type, off first', () => {
    const all: Partial<ReadyInput> = {
      settings: settings({ enabled: false }),
      models: [],
      idleSeconds: 0,
      onBattery: true,
      agentWorking: true,
      running: true,
      overLimit: true,
      repos: [],
    };
    const steps: [Partial<ReadyInput>, string][] = [
      [{}, 'off'],
      [{ settings: settings() }, 'model-missing'],
      [{ models: [MODEL] }, 'active'],
      [{ idleSeconds: 600 }, 'battery'],
      [{ onBattery: false }, 'agents-busy'],
      [{ agentWorking: false }, 'running'],
      [{ running: false }, 'limit'],
      [{ overLimit: false }, 'nothing-ready'],
      [{ repos: [repo('a')] }, 'a'],
    ];
    let acc = { ...all };
    for (const [change, want] of steps) {
      acc = { ...acc, ...change };
      const got = nextDream(input(acc));
      expect('wait' in got ? got.wait : got.repoId).toBe(want);
    }
  });

  it('is model-missing when the list is unknown or lacks the model, or no model is chosen', () => {
    expect(nextDream(input({ models: null }))).toEqual({
      wait: 'model-missing',
    });
    expect(nextDream(input({ models: ['other/model'] }))).toEqual({
      wait: 'model-missing',
    });
    expect(nextDream(input({ settings: settings({ model: null }) }))).toEqual({
      wait: 'model-missing',
    });
  });

  it('waits for idleMinutes of no input: 599 s is active, 600 s is ready', () => {
    expect(nextDream(input({ idleSeconds: 599 }))).toEqual({ wait: 'active' });
    expect(nextDream(input({ idleSeconds: 600 }))).toEqual({ repoId: 'a' });
  });

  it('never picks a repo that is off, has no folders, has an open result, no material or is backing off', () => {
    const s = settings({
      repos: {
        off: { on: false, folders: ['.apm'] },
        empty: { on: true, folders: [] },
        open: { on: true, folders: ['.apm'] },
        dry: { on: true, folders: ['.apm'] },
        failing: { on: true, folders: ['.apm'] },
      },
    });
    const repos = [
      repo('off'),
      repo('empty'),
      repo('open', { state: state({ result }) }),
      repo('dry', { hasMaterial: false }),
      repo('failing', {
        state: state({
          failures: 1,
          lastFailureAt: new Date(NOW - 10 * 60_000).toISOString(),
        }),
      }),
      repo('unknown'),
    ];
    expect(nextDream(input({ settings: s, repos }))).toEqual({
      wait: 'nothing-ready',
    });
  });

  it('of two ready repos picks the one that dreamt longest ago, null counting as oldest', () => {
    const old = state({ lastDreamAt: new Date(NOW - 48 * H).toISOString() });
    const recent = state({ lastDreamAt: new Date(NOW - 2 * H).toISOString() });
    expect(
      nextDream(
        input({
          repos: [repo('a', { state: recent }), repo('b', { state: old })],
        }),
      ),
    ).toEqual({ repoId: 'b' });
    expect(
      nextDream(input({ repos: [repo('a', { state: old }), repo('b')] })),
    ).toEqual({ repoId: 'b' });
  });

  it('Dream now picks its repo while active, on battery, with agents busy and backing off', () => {
    const failing = state({
      failures: 3,
      lastFailureAt: new Date(NOW - 60_000).toISOString(),
    });
    const i = input({
      idleSeconds: 0,
      onBattery: true,
      agentWorking: true,
      repos: [repo('a'), repo('b', { state: failing })],
    });
    expect(nextDream(i)).toEqual({ wait: 'active' });
    expect(nextDream(i, { repoId: 'b' })).toEqual({ repoId: 'b' });
  });

  it('Dream now still waits for running, the limit, the model and off', () => {
    const manual = { repoId: 'a' };
    expect(nextDream(input({ running: true }), manual)).toEqual({
      wait: 'running',
    });
    expect(nextDream(input({ overLimit: true }), manual)).toEqual({
      wait: 'limit',
    });
    expect(nextDream(input({ models: null }), manual)).toEqual({
      wait: 'model-missing',
    });
    expect(
      nextDream(input({ settings: settings({ enabled: false }) }), manual),
    ).toEqual({ wait: 'off' });
  });

  it('Dream now for a repo with an open result, or another repo, is nothing-ready', () => {
    const i = input({ repos: [repo('a', { state: state({ result }) })] });
    expect(nextDream(i, { repoId: 'a' })).toEqual({ wait: 'nothing-ready' });
    expect(nextDream(input(), { repoId: 'b' })).toEqual({
      wait: 'nothing-ready',
    });
  });
});

describe('backoffUntil', () => {
  const failedAt = NOW - 5 * 60_000;
  const failed = (failures: number) =>
    state({
      failures,
      lastFailureAt: new Date(failedAt).toISOString(),
      lastFailure: 'OpenCode stopped',
    });

  it('is null without failures', () => {
    expect(backoffUntil(state(), null)).toBeNull();
  });

  it('is 1 h after the first failure, 6 h after the second, for good after the third', () => {
    expect(backoffUntil(failed(1), null)).toBe(failedAt + H);
    expect(backoffUntil(failed(2), failedAt - 1)).toBe(failedAt + 6 * H);
    expect(backoffUntil(failed(3), failedAt)).toBe(Infinity);
    expect(backoffUntil(failed(4), null)).toBe(Infinity);
  });

  it('ends once there is material newer than the last failure, also after three', () => {
    expect(backoffUntil(failed(1), failedAt + 1)).toBeNull();
    expect(backoffUntil(failed(3), failedAt + 1)).toBeNull();
  });

  it('keeps a repo inside its back-off out, and lets it in after', () => {
    const s = failed(1);
    const i = (now: number) =>
      input({
        now,
        repos: [repo('a', { state: s, newestMaterialAt: failedAt - H })],
      });
    expect(nextDream(i(failedAt + H - 1))).toEqual({ wait: 'nothing-ready' });
    expect(nextDream(i(failedAt + H))).toEqual({ repoId: 'a' });
  });
});
