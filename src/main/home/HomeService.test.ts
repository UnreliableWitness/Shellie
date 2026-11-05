import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Connection, SprintItem } from '../../shared/types';
import { AdoError, type RawHomePr } from '../services/AdoClient';
import { HomeService, type HomeClient, type HomeDeps } from './HomeService';

const conn = (id: string): Connection => ({
  id,
  name: id,
  organizationUrl: `https://dev.azure.com/${id}`,
  project: 'P',
  user: null,
  status: 'ok',
  checkedAt: null,
  userUniqueName: null,
  provider: 'azure-devops' as const,
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
});

const item = (
  id: number,
  iterationPath: string,
  state = 'To Do',
): SprintItem => ({
  id: String(id),
  type: 'Issue',
  title: `Item ${id}`,
  state,
  areaPath: 'P',
  iterationPath,
  assignedTo: 'Me',
  url: `https://x/${id}`,
  project: null,
  remainingWork: null,
  originalEstimate: null,
  completedWork: null,
});

const pr = (id: number, over: Partial<RawHomePr> = {}): RawHomePr => ({
  pullRequestId: id,
  title: `PR ${id}`,
  creationDate: `2026-10-${10 + id}T00:00:00Z`,
  repository: { name: 'web' },
  createdBy: { id: 'anna', displayName: 'Anna' },
  reviewers: [],
  ...over,
});

/** A client where every call works; tests override single methods. */
function fakeClient(over: Partial<HomeClient> = {}): HomeClient {
  return {
    me: async () => 'me',
    myTeams: async () => [{ id: 't1', name: 'Team 1' }],
    currentIteration: async () => ({
      id: 'i1',
      name: 'Sprint 1',
      path: 'P\\Sprint 1',
      startDate: null,
      finishDate: '2026-10-23T00:00:00Z',
    }),
    assignedInIterations: async () => [1, 2],
    workItems: async (_p, ids) => ids.map((id) => item(id, 'P\\Sprint 1')),
    activePullRequests: async () => [],
    ...over,
  };
}

function service(
  connections: Connection[],
  clients: Record<string, HomeClient>,
  file = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'shellie-home-')),
    'home.json',
  ),
  extra: Partial<HomeDeps> = {},
) {
  const built: {
    connections: number;
    failed: number;
    failures: { kind: string }[];
  }[] = [];
  const home = new HomeService({
    file,
    connections: () => connections,
    client: (id) => clients[id],
    now: () => new Date('2026-10-17T09:12:00Z'),
    timeoutMs: 200,
    onBuilt: (_s, info) => built.push(info),
    ...extra,
  });
  return { home, file, built };
}

describe('HomeService', () => {
  it('builds a sprint card per iteration holding my items', async () => {
    const { home } = service([conn('a')], { a: fakeClient() });
    const s = await home.refresh();
    expect(s.connections[0]).toMatchObject({
      connectionId: 'a',
      status: 'ok',
      error: null,
      fetchedAt: '2026-10-17T09:12:00.000Z',
      sprintsError: null,
    });
    expect(s.connections[0].sprints).toHaveLength(1);
    expect(s.connections[0].sprints[0].items.map((i) => i.id)).toEqual([
      '1',
      '2',
    ]);
  });

  it('deduplicates iterations shared by two of my teams', async () => {
    const calls: string[] = [];
    const { home } = service([conn('a')], {
      a: fakeClient({
        myTeams: async () => [
          { id: 't1', name: 'Team 1' },
          { id: 't2', name: 'Team 2' },
        ],
        assignedInIterations: async (_p, paths) => {
          calls.push(...paths);
          return [1];
        },
      }),
    });
    const s = await home.refresh();
    expect(calls).toEqual(['P\\Sprint 1']);
    expect(s.connections[0].sprints).toHaveLength(1);
  });

  it('leaves out iterations with nothing of mine', async () => {
    const { home } = service([conn('a')], {
      a: fakeClient({ assignedInIterations: async () => [] }),
    });
    expect((await home.refresh()).connections[0].sprints).toEqual([]);
  });

  it('splits named and team reviews and skips my own PRs', async () => {
    const { home } = service([conn('a')], {
      a: fakeClient({
        activePullRequests: async (_p, c) => {
          if ('creatorId' in c)
            return [pr(9, { createdBy: { id: 'me', displayName: 'Me' } })];
          if (c.reviewerId === 'me')
            return [
              pr(1, { reviewers: [{ id: 'me', vote: 0 }] }),
              pr(2, { reviewers: [{ id: 'me', vote: 10 }] }),
            ];
          return [
            pr(1, {
              reviewers: [
                { id: 'me', vote: 0 },
                { id: 't1', vote: 0 },
              ],
            }),
            pr(3, { reviewers: [{ id: 't1', vote: 0 }] }),
            pr(9, {
              createdBy: { id: 'me', displayName: 'Me' },
              reviewers: [{ id: 't1', vote: 0 }],
            }),
          ];
        },
      }),
    });
    const c = (await home.refresh()).connections[0];
    expect(c.reviews.map((p) => p.id)).toEqual([1]);
    expect(c.teamReviews.map((p) => p.id)).toEqual([3]);
    expect(c.myPrs.map((p) => p.id)).toEqual([9]);
  });

  it('keeps stale data for a refused connection while another updates', async () => {
    let refuse = false;
    const a = fakeClient({
      me: async () => {
        if (refuse)
          throw new AdoError(
            'unauthorized',
            '/x',
            'Azure DevOps rejected the token',
          );
        return 'me';
      },
    });
    let bItems = [1];
    const b = fakeClient({ assignedInIterations: async () => bItems });
    const { home } = service([conn('a'), conn('b')], { a, b });
    await home.refresh();
    refuse = true;
    bItems = [1, 2];
    const s = await home.refresh();
    expect(s.connections[0]).toMatchObject({
      status: 'stale',
      error: 'Azure DevOps rejected the token',
      fetchedAt: '2026-10-17T09:12:00.000Z',
    });
    expect(s.connections[0].sprints[0].items).toHaveLength(2);
    expect(s.connections[1].status).toBe('ok');
    expect(s.connections[1].sprints[0].items).toHaveLength(2);
  });

  it('marks a connection that never worked as error', async () => {
    const { home } = service([conn('a')], {
      a: fakeClient({
        me: async () => {
          throw new AdoError('unreachable', '/x', 'Could not reach');
        },
      }),
    });
    expect((await home.refresh()).connections[0]).toMatchObject({
      status: 'error',
      error: 'Could not reach',
      fetchedAt: null,
      sprints: [],
    });
  });

  it('a failing PR call keeps the sprints and the earlier PRs', async () => {
    let fail = false;
    const { home } = service([conn('a')], {
      a: fakeClient({
        activePullRequests: async (_p, c) => {
          if (fail) throw new AdoError('unauthorized', '/x', 'no code scope');
          return 'creatorId' in c
            ? [pr(5, { createdBy: { id: 'me', displayName: 'Me' } })]
            : [];
        },
      }),
    });
    await home.refresh();
    fail = true;
    const c = (await home.refresh()).connections[0];
    expect(c.status).toBe('ok');
    expect(c.prsError).toBe('no code scope');
    expect(c.myPrs.map((p) => p.id)).toEqual([5]);
    expect(c.sprints).toHaveLength(1);
  });

  it('PR calls do not go through withConnection, so a missing scope never flips the connection', async () => {
    const wrapped: string[] = [];
    const { home } = service(
      [conn('a')],
      {
        a: fakeClient({
          activePullRequests: async () => {
            throw new AdoError('unauthorized', '/x', 'no code scope');
          },
        }),
      },
      undefined,
      {
        withConnection: async (_id, run) => {
          wrapped.push('call');
          return run();
        },
      },
    );
    const c = (await home.refresh()).connections[0];
    expect(c.prsError).toBe('no code scope');
    expect(wrapped.length).toBeGreaterThan(0);
    // me, myTeams, currentIteration, assignedInIterations, workItems only
    expect(wrapped).toHaveLength(5);
  });

  it('refresh still resolves when onBuilt throws or connections() throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { home } = service([conn('a')], { a: fakeClient() }, undefined, {
      onBuilt: () => {
        throw new Error('telemetry broke');
      },
    });
    expect((await home.refresh()).connections).toHaveLength(1);
    const broken = service([conn('a')], { a: fakeClient() }, undefined, {
      connections: () => {
        throw new Error('store broke');
      },
    });
    expect((await broken.home.refresh()).connections).toEqual([]);
    spy.mockRestore();
  });

  it('reports a failure kind per non-ok connection, without names', async () => {
    const { home, built } = service(
      [conn('a'), conn('b'), conn('c'), conn('d')],
      {
        a: fakeClient({
          me: async () => {
            throw new AdoError('unauthorized', '/x', 'rejected');
          },
        }),
        b: fakeClient({
          me: async () => {
            throw new AdoError('unreachable', '/x', 'down');
          },
        }),
        c: fakeClient({ me: () => new Promise<string>(() => undefined) }),
        d: fakeClient({
          activePullRequests: async () => {
            throw new AdoError('not-found', '/x', 'nope');
          },
        }),
      },
    );
    await home.refresh();
    expect(built[0].failures.map((f) => f.kind).sort()).toEqual([
      'step',
      'timeout',
      'unauthorized',
      'unreachable',
    ]);
    expect(built[0].failed).toBe(3);
  });

  it('times out a connection that hangs', async () => {
    const { home } = service([conn('a')], {
      a: fakeClient({ me: () => new Promise<string>(() => undefined) }),
    });
    const c = (await home.refresh()).connections[0];
    expect(c.status).toBe('error');
    expect(c.error).toMatch(/did not answer within/);
  });

  it('joins a refresh requested during a rebuild', async () => {
    let calls = 0;
    const { home } = service([conn('a')], {
      a: fakeClient({
        me: async () => {
          calls++;
          return 'me';
        },
      }),
    });
    const [x, y] = await Promise.all([home.refresh(), home.refresh()]);
    expect(x).toBe(y);
    expect(calls).toBe(1);
  });

  it('drops a removed connection and writes the snapshot to disk', async () => {
    const list = [conn('a'), conn('b')];
    const { home, file, built } = service(list, {
      a: fakeClient(),
      b: fakeClient(),
    });
    await home.refresh();
    list.pop();
    const s = await home.refresh();
    expect(s.connections.map((c) => c.connectionId)).toEqual(['a']);
    expect(JSON.parse(readFileSync(file, 'utf8')).connections).toHaveLength(1);
    expect(built.at(-1)).toEqual({
      connections: 1,
      failed: 0,
      failures: [],
      durationMs: expect.any(Number),
    });
  });

  it('serves the snapshot from disk after a restart', async () => {
    const first = service([conn('a')], { a: fakeClient() });
    await first.home.refresh();
    const again = service([conn('a')], { a: fakeClient() }, first.file);
    expect((await again.home.get())?.connections[0].sprints).toHaveLength(1);
  });

  it('keeps status error when a never-worked connection fails again', async () => {
    const { home } = service([conn('a')], {
      a: fakeClient({
        me: async () => {
          throw new AdoError('unreachable', '/x', 'Could not reach');
        },
      }),
    });
    await home.refresh();
    expect((await home.refresh()).connections[0]).toMatchObject({
      status: 'error',
      fetchedAt: null,
      sprints: [],
    });
  });

  it('one team failing its iteration still counts the other team', async () => {
    const { home } = service([conn('a')], {
      a: fakeClient({
        myTeams: async () => [
          { id: 't1', name: 'Team 1' },
          { id: 't2', name: 'Team 2' },
        ],
        currentIteration: async (_p, team) => {
          if (team === 'Team 2')
            throw new AdoError('http', '/x', 'team 2 broke');
          return {
            id: 'i1',
            name: 'Sprint 1',
            path: 'P\\Sprint 1',
            startDate: null,
            finishDate: null,
          };
        },
        activePullRequests: async (_p, c) =>
          'creatorId' in c
            ? [pr(5, { createdBy: { id: 'me', displayName: 'Me' } })]
            : [],
      }),
    });
    const c = (await home.refresh()).connections[0];
    expect(c.status).toBe('ok');
    expect(c.sprints).toHaveLength(1);
    expect(c.sprintsError).toBe('team 2 broke');
    expect(c.prsError).toBeNull();
    expect(c.myPrs.map((p) => p.id)).toEqual([5]);
  });

  it('a failing myTeams fails only the sprints part', async () => {
    let fail = false;
    const { home } = service([conn('a')], {
      a: fakeClient({
        myTeams: async () => {
          if (fail) throw new AdoError('http', '/x', 'teams broke');
          return [{ id: 't1', name: 'Team 1' }];
        },
        activePullRequests: async (_p, c) => {
          if ('creatorId' in c)
            return [pr(5, { createdBy: { id: 'me', displayName: 'Me' } })];
          return c.reviewerId === 'me'
            ? [pr(1, { reviewers: [{ id: 'me', vote: 0 }] })]
            : [];
        },
      }),
    });
    await home.refresh();
    fail = true;
    const c = (await home.refresh()).connections[0];
    expect(c.status).toBe('ok');
    expect(c.sprintsError).toBe('teams broke');
    expect(c.sprints).toHaveLength(1);
    expect(c.reviews.map((p) => p.id)).toEqual([1]);
    expect(c.myPrs.map((p) => p.id)).toEqual([5]);
  });
});
