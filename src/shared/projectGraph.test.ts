import { describe, expect, it } from 'vitest';
import {
  RepoSchema,
  TaskSchema,
  type Repo,
  type Task,
  type Workspace,
} from './types';
import { EDGE_WINDOW_DAYS, projectGraph, projectTasks } from './projectGraph';

const mkTask = (over: Partial<Task> = {}): Task =>
  TaskSchema.parse({
    id: 't1',
    repoId: 'r1',
    name: 'n',
    workItem: null,
    slug: 's',
    branch: 'feature/a',
    worktreePath: '/wt/a',
    baseRef: 'main',
    status: 'ready',
    setup: { copy: true, commands: [], startClaude: false, openShell: true },
    terminals: [],
    createdAt: '2026-10-16T00:00:00.000Z',
    finishedAt: null,
    ...over,
  });

const mkRepo = (
  id: string,
  connectionId: string | null,
  over: Partial<Repo> = {},
): Repo =>
  RepoSchema.parse({
    id,
    name: id,
    path: `/repos/${id}`,
    baseBranch: 'main',
    connectionId,
    configFound: true,
    ...over,
  }) as Repo;

const extra = (over: Partial<Workspace> = {}): Workspace => ({
  id: 'w2',
  repoId: 'r2',
  branch: 'feature/b',
  worktreePath: '/wt/b',
  baseRef: 'main',
  baseSha: null,
  source: 'detected',
  summary: null,
  pullRequest: null,
  reopen: null,
  dropped: false,
  ...over,
});

const now = new Date('2026-11-05T12:00:00.000Z');
const daysAgo = (d: number) =>
  new Date(now.getTime() - d * 86_400_000).toISOString();
const connections = [
  { id: 'c1', project: 'Shellie' },
  { id: 'c2', project: 'IML HUB' },
];
const repos = [mkRepo('r1', 'c1'), mkRepo('r2', 'c2'), mkRepo('r3', 'c1')];
const graph = (tasks: Task[], rs = repos) =>
  projectGraph({ tasks, repos: rs, connections, connectionId: 'c1', now });

describe('projectGraph', () => {
  it('a task spanning a linked repo and a repo of another project gives one edge and one elsewhere node', () => {
    const g = graph([mkTask({ extraWorkspaces: [extra()] })]);
    expect(g.linked.map((n) => n.repoId)).toEqual(['r1', 'r3']);
    expect(g.elsewhere).toHaveLength(1);
    expect(g.elsewhere[0].repoId).toBe('r2');
    expect(g.elsewhere[0].projectName).toBe('IML HUB');
    expect(g.edges).toEqual([{ a: 'r1', b: 'r2', taskIds: ['t1'] }]);
  });

  it('two tasks on the same pair thicken one edge, not two', () => {
    const g = graph([
      mkTask({ id: 't1', extraWorkspaces: [extra()] }),
      mkTask({ id: 't2', extraWorkspaces: [extra()] }),
    ]);
    expect(g.edges).toEqual([{ a: 'r1', b: 'r2', taskIds: ['t1', 't2'] }]);
    expect(g.elsewhere).toHaveLength(1);
  });

  it('a done task older than 90 days adds no edge; one finished 89 days ago does', () => {
    expect(EDGE_WINDOW_DAYS).toBe(90);
    const old = mkTask({
      id: 'old',
      status: 'done',
      finishedAt: daysAgo(91),
      extraWorkspaces: [extra()],
    });
    const recent = mkTask({
      id: 'new',
      status: 'done',
      finishedAt: daysAgo(89),
      extraWorkspaces: [extra()],
    });
    expect(graph([old]).edges).toEqual([]);
    expect(graph([recent]).edges).toEqual([
      { a: 'r1', b: 'r2', taskIds: ['new'] },
    ]);
  });

  it('a task whose connectionId is another project but whose home repo is linked here counts here', () => {
    const t = mkTask({ connectionId: 'c2', extraWorkspaces: [extra()] });
    expect(projectTasks([t], repos, 'c1', now)).toEqual([t]);
    expect(projectTasks([t], repos, 'c2', now)).toEqual([]);
    expect(graph([t]).edges).toHaveLength(1);
  });

  it('a dropped workspace adds no node and no edge', () => {
    const g = graph([mkTask({ extraWorkspaces: [extra({ dropped: true })] })]);
    expect(g.elsewhere).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it('foundByClaude is true only when every bringing workspace is detected', () => {
    const detected = mkTask({ id: 'a', extraWorkspaces: [extra()] });
    const manual = mkTask({
      id: 'b',
      extraWorkspaces: [extra({ source: 'manual' })],
    });
    expect(graph([detected]).elsewhere[0].foundByClaude).toBe(true);
    expect(graph([detected, manual]).elsewhere[0].foundByClaude).toBe(false);
  });

  it('setupMissing is false when a setup override exists', () => {
    const rs = [
      mkRepo('r1', 'c1', { configFound: false }),
      mkRepo('r3', 'c1', { configFound: false, overrides: { setup: [] } }),
    ];
    const g = graph([], rs);
    expect(g.linked.map((n) => n.setupMissing)).toEqual([true, false]);
  });

  it('a no-repo task with this connectionId counts for projectTasks but adds nothing to the graph', () => {
    const t = mkTask({ repoId: null, connectionId: 'c1' });
    expect(projectTasks([t], repos, 'c1', now)).toEqual([t]);
    const g = graph([t]);
    expect(g.edges).toEqual([]);
    expect(g.elsewhere).toEqual([]);
    expect(g.linked.every((n) => n.openTasks === 0)).toBe(true);
  });

  it('an extra workspace with a pull request lights its linked repo, not the task home', () => {
    const pr = {
      id: 1,
      url: 'u',
      repositoryId: 'x',
      project: 'p',
      repo: 'r',
      status: 'active',
      isDraft: false,
    } as const;
    const g = graph([
      mkTask({ extraWorkspaces: [extra({ repoId: 'r3', pullRequest: pr })] }),
    ]);
    const [n1, n3] = g.linked;
    expect([n1.openTasks, n1.prOpen]).toEqual([1, false]);
    expect([n3.openTasks, n3.prOpen]).toEqual([0, true]);
  });

  it('counts open tasks and open pull requests per linked repo', () => {
    const pr = {
      id: 1,
      url: 'u',
      repositoryId: 'x',
      project: 'p',
      repo: 'r',
      status: 'active',
      isDraft: false,
    } as const;
    const g = graph([
      mkTask({ id: 'a', pullRequest: pr }),
      mkTask({
        id: 'b',
        status: 'done',
        finishedAt: daysAgo(1),
        pullRequest: pr,
      }),
      mkTask({
        id: 'c',
        repoId: 'r3',
        extraWorkspaces: [extra({ repoId: 'r3', pullRequest: pr })],
      }),
    ]);
    const [n1, n3] = g.linked;
    expect([n1.openTasks, n1.prOpen]).toEqual([1, true]);
    expect([n3.openTasks, n3.prOpen]).toEqual([1, true]);
  });
});
