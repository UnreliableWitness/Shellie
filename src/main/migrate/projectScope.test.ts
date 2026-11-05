import { describe, expect, it, vi } from 'vitest';
import {
  ConnectionSchema,
  type Connection,
  type Repo,
} from '../../shared/types';
import { defaultSettings } from '../../shared/usage';
import {
  applyProjectScopeMigration,
  migrateStartSettings,
  migrateWriteTime,
} from './projectScope';

const conn = (id: string, over: Partial<Connection> = {}): Connection =>
  ConnectionSchema.parse({
    id,
    name: id,
    organizationUrl: 'https://dev.azure.com/o',
    project: 'p',
    user: null,
    status: 'ok',
    checkedAt: null,
    ...over,
  });

const repo = (
  id: string,
  connectionId: string | null,
  workItemOnStart?: Repo['workItemOnStart'],
): Repo =>
  ({
    id,
    name: id,
    path: `/r/${id}`,
    baseBranch: 'main',
    connectionId,
    configFound: false,
    discovered: false,
    workItemOnStart,
    overrides: {},
  }) as Repo;

describe('migrateWriteTime', () => {
  it('copies the legacy flag onto every connection and removes it from settings', () => {
    const settings = { ...defaultSettings(), writeTimeToAdo: true };
    const out = migrateWriteTime(settings, [conn('a'), conn('b')]);
    expect(out?.patches).toEqual([
      { id: 'a', writeTimeToAdo: true },
      { id: 'b', writeTimeToAdo: true },
    ]);
    expect('writeTimeToAdo' in (out?.settings ?? {})).toBe(false);
  });
  it('returns null when the legacy key is absent', () => {
    expect(migrateWriteTime(defaultSettings(), [conn('a')])).toBeNull();
  });
});

describe('migrateStartSettings', () => {
  const c = conn('a');
  it("drops a repo value equal to its project's and keeps a different one", () => {
    const same = structuredClone(c.workItemOnStart);
    const other = { ...same, assignToMe: !same.assignToMe };
    const repos = [
      repo('r1', 'a', same),
      repo('r2', 'a', other),
      repo('r3', null, same),
    ];
    expect(migrateStartSettings(repos, [c])).toEqual([{ id: 'r1' }]);
  });
  it('is idempotent', () => {
    const repos = [repo('r1', 'a', structuredClone(c.workItemOnStart))];
    const ids = migrateStartSettings(repos, [c]).map((r) => r.id);
    const after = repos.map((r) =>
      ids.includes(r.id) ? { ...r, workItemOnStart: undefined } : r,
    );
    expect(migrateStartSettings(after, [c])).toEqual([]);
  });
});

describe('applyProjectScopeMigration', () => {
  it('keeps going when one patch fails: others apply, settings stay, repo copies are stripped', async () => {
    const a = conn('a');
    const b = conn('b');
    const settings = {
      current: { ...defaultSettings(), writeTimeToAdo: true },
      get() {
        return this.current;
      },
      save: vi.fn(async () => {}),
    };
    const patch = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('disk full');
    });
    const state = {
      repos: [repo('r1', 'b', structuredClone(b.workItemOnStart))],
    };
    const log = vi.fn();
    await applyProjectScopeMigration({
      settings,
      connections: { list: () => [a, b], patch },
      store: {
        state,
        update: async (m) => {
          m(state);
        },
      },
      log,
    });
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledWith('b', { writeTimeToAdo: true });
    expect(settings.save).not.toHaveBeenCalled();
    expect(state.repos[0].workItemOnStart).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });
  it('saves the settings without the legacy key when every patch succeeds', async () => {
    const settings = {
      get: () => ({ ...defaultSettings(), writeTimeToAdo: true }),
      save: vi.fn(async () => {}),
    };
    await applyProjectScopeMigration({
      settings,
      connections: { list: () => [conn('a')], patch: async () => {} },
      store: { state: { repos: [] }, update: async () => {} },
      log: vi.fn(),
    });
    expect(settings.save).toHaveBeenCalledTimes(1);
  });
});
