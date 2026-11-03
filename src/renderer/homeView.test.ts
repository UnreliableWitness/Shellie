import { describe, expect, it } from 'vitest';
import type { HomeConnection, HomeItem, HomeSnapshot } from '../shared/home';
import type { Connection, Repo, TaskView } from '../shared/types';
import { chipState, connectionNote, sprintTotals, upNext } from './homeView';

const connection = { id: 'c1', status: 'ok' } as Connection;
const home = (status: HomeConnection['status']) =>
  ({ status }) as HomeConnection;

describe('chipState', () => {
  it('is error when the token is refused or the build never loaded', () => {
    expect(
      chipState(home('ok'), { ...connection, status: 'unauthorized' }),
    ).toBe('error');
    expect(chipState(home('error'), connection)).toBe('error');
  });
  it('is stale when unreachable or the last build failed but data is kept', () => {
    expect(chipState(home('stale'), connection)).toBe('stale');
    expect(
      chipState(home('ok'), { ...connection, status: 'unreachable' }),
    ).toBe('stale');
    expect(chipState(undefined, { ...connection, status: 'unreachable' })).toBe(
      'stale',
    );
  });
  it('is ok otherwise, also before the first build', () => {
    expect(chipState(home('ok'), connection)).toBe('ok');
    expect(chipState(undefined, connection)).toBe('ok');
  });
});

const hi = (id: string, state = 'To Do'): HomeItem => ({
  id,
  type: 'Issue',
  title: `Item ${id}`,
  state,
  areaPath: 'P',
  iterationPath: 'P\\S1',
  assignedTo: 'Me',
  url: `https://x/${id}`,
  project: null,
  remainingWork: null,
  originalEstimate: null,
  completedWork: null,
});
const snap = (items: HomeItem[]): HomeSnapshot => ({
  version: 1,
  builtAt: '',
  connections: [
    {
      connectionId: 'c1',
      name: 'uw',
      project: 'P',
      status: 'ok',
      error: null,
      fetchedAt: '',
      sprints: [
        {
          iterationId: 'i',
          name: 'S1',
          path: 'P\\S1',
          startDate: null,
          finishDate: null,
          items,
        },
      ],
      sprintsError: null,
      reviews: [],
      teamReviews: [],
      myPrs: [],
      prsError: null,
    },
  ],
});
const repos = [{ id: 'r1', connectionId: 'c1' }] as Repo[];
const noMeta = () => undefined;

describe('upNext', () => {
  it('takes not-started items, at most three', () => {
    const s = snap([hi('1'), hi('2', 'Doing'), hi('3'), hi('4'), hi('5')]);
    expect(upNext(s, [], repos, noMeta).map((u) => u.item.id)).toEqual([
      '1',
      '3',
      '4',
    ]);
  });
  it('drops an item once it has a task', () => {
    const s = snap([hi('1'), hi('3')]);
    const tasks = [
      {
        id: 't',
        repoId: 'r1',
        connectionId: null,
        workItem: { id: '1' },
        status: 'setting-up',
      },
    ] as TaskView[];
    expect(upNext(s, tasks, repos, noMeta).map((u) => u.item.id)).toEqual([
      '3',
    ]);
  });
  it('an item with the same id on another connection still counts', () => {
    const s = snap([hi('1')]);
    const tasks = [
      {
        id: 't',
        repoId: 'r2',
        connectionId: 'c2',
        workItem: { id: '1' },
        status: 'ready',
      },
    ] as TaskView[];
    expect(upNext(s, tasks, repos, noMeta)).toHaveLength(1);
  });
  it('uses the type metadata category', () => {
    const s = snap([hi('1', 'Approved by PO')]);
    expect(upNext(s, [], repos, () => 'Proposed')).toHaveLength(1);
    expect(upNext(s, [], repos, () => 'InProgress')).toHaveLength(0);
  });
});

describe('sprintTotals', () => {
  const sprint = {
    iterationId: 'i',
    name: 'S1',
    path: 'P\\S1',
    startDate: null,
    finishDate: null,
    items: [
      { ...hi('1'), originalEstimate: 4 },
      { ...hi('2', 'Doing'), originalEstimate: 2, completedWork: 1 },
      { ...hi('3', 'Done') },
      { ...hi('4', 'Removed') },
    ],
  };
  it('counts my items by state category, without removed ones', () => {
    expect(sprintTotals(sprint, {}, () => undefined)).toMatchObject({
      todo: 1,
      doing: 1,
      done: 1,
    });
  });
  it('adds spent and estimate as the Sprint page does', () => {
    const local = {
      '1': {
        spentSeconds: 3600,
        measuredSeconds: 3600,
        agentSeconds: 0,
        booked: false,
        baselineHours: null,
      },
    };
    expect(sprintTotals(sprint, local, () => undefined)).toMatchObject({
      spentSeconds: 3600 + 3600,
      estimateHours: 6,
    });
  });
  it('has no estimate when no item has one', () => {
    const bare = { ...sprint, items: [hi('9')] };
    expect(sprintTotals(bare, {}, () => undefined).estimateHours).toBeNull();
  });
});

describe('connectionNote', () => {
  const c = (over: Partial<HomeConnection>) =>
    ({
      name: 'uw',
      project: 'Shellie',
      status: 'ok',
      error: null,
      fetchedAt: null,
      ...over,
    }) as HomeConnection;
  it('is null when ok', () => {
    expect(connectionNote(c({}))).toBeNull();
  });
  it('says stale since the fetch time', () => {
    expect(
      connectionNote(
        c({
          status: 'stale',
          fetchedAt: '2026-10-17T09:12:00Z',
          error: 'down',
        }),
      ),
    ).toMatch(/^Stale since \d\d:\d\d for uw\/Shellie: down$/);
  });
  it('says it could not load with the error', () => {
    expect(connectionNote(c({ status: 'error', error: 'refused' }))).toBe(
      "Couldn't load uw/Shellie: refused",
    );
  });
});
