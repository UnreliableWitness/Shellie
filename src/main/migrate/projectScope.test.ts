import { describe, expect, it } from 'vitest';
import {
  ConnectionSchema,
  type Connection,
  type Repo,
} from '../../shared/types';
import { defaultSettings } from '../../shared/usage';
import { migrateStartSettings, migrateWriteTime } from './projectScope';

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
