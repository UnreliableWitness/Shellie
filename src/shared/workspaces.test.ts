import { describe, expect, it } from 'vitest';
import { TaskSchema, type Task, type Workspace } from './types';
import {
  activeHome,
  activeWorkspaces,
  isReopening,
  dropsAtFinish,
  REPO_COLORS,
  repoColor,
  taskConnectionId,
  taskWorkspaces,
  workspaceById,
} from './workspaces';

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

describe('workspaces', () => {
  it('a task without extras has one home view with the flat fields', () => {
    const views = taskWorkspaces(mkTask());
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: 'home',
      source: 'home',
      repoId: 'r1',
      branch: 'feature/a',
      worktreePath: '/wt/a',
      baseRef: 'main',
      dropped: false,
    });
  });

  it('lists home first, then the extras', () => {
    const t = mkTask({ extraWorkspaces: [extra()] });
    expect(taskWorkspaces(t).map((w) => w.id)).toEqual(['home', 'w2']);
  });

  it('activeHome falls to the first extra when home is dropped', () => {
    const t = mkTask({
      homeDropped: true,
      extraWorkspaces: [extra({ id: 'gone', dropped: true }), extra()],
    });
    expect(activeHome(t).id).toBe('w2');
    expect(activeWorkspaces(t).map((w) => w.id)).toEqual(['w2']);
  });

  it('isReopening: the home or a kept extra marked by Reopen, never a dropped one', () => {
    expect(isReopening(mkTask())).toBe(false);
    expect(isReopening(mkTask({ reopen: { from: null } }))).toBe(true);
    expect(
      isReopening(
        mkTask({
          homeDropped: true,
          extraWorkspaces: [extra({ reopen: { from: 'origin/feature/b' } })],
        }),
      ),
    ).toBe(true);
    expect(
      isReopening(
        mkTask({
          extraWorkspaces: [extra({ reopen: { from: null }, dropped: true })],
        }),
      ),
    ).toBe(false);
  });

  it('workspaceById resolves undefined to the active home and rejects unknown ids', () => {
    const t = mkTask({ extraWorkspaces: [extra()] });
    expect(workspaceById(t, undefined).id).toBe('home');
    expect(workspaceById(t, 'w2').repoId).toBe('r2');
    expect(() => workspaceById(t, 'nope')).toThrow('Unknown workspace nope');
  });

  it('taskConnectionId prefers the task, then the home repo, else null', () => {
    const repos = [{ id: 'r1', connectionId: 'c1' }];
    expect(taskConnectionId(mkTask({ connectionId: 'c2' }), repos)).toBe('c2');
    expect(taskConnectionId(mkTask(), repos)).toBe('c1');
    expect(taskConnectionId(mkTask(), [])).toBeNull();
  });
});

describe('repoColor', () => {
  const ws = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      extra({ id: `w${i + 2}`, repoId: `r${i + 2}` }),
    );

  it('gives a single-repo task no color', () => {
    expect(repoColor(mkTask(), 'home')).toBeNull();
    // An extra repo that left the task does not count.
    const t = mkTask({ extraWorkspaces: [extra({ dropped: true })] });
    expect(repoColor(t, 'home')).toBeNull();
  });

  it('numbers the repos in task order, home first', () => {
    const t = mkTask({ extraWorkspaces: ws(2) });
    expect(repoColor(t, 'home')).toBe(1);
    expect(repoColor(t, 'w2')).toBe(2);
    expect(repoColor(t, 'w3')).toBe(3);
  });

  it('keeps a color when an earlier repo leaves the task', () => {
    const t = mkTask({
      extraWorkspaces: [extra({ id: 'w2', dropped: true }), ...ws(3).slice(1)],
    });
    expect(repoColor(t, 'w3')).toBe(3);
    expect(repoColor(t, 'w2')).toBeNull();
  });

  it('wraps after the last color', () => {
    const t = mkTask({ extraWorkspaces: ws(REPO_COLORS) });
    expect(repoColor(t, `w${REPO_COLORS + 1}`)).toBe(1);
  });

  it('has no color for an unknown repo', () => {
    expect(repoColor(mkTask({ extraWorkspaces: ws(1) }), 'nope')).toBeNull();
  });
});

describe('dropsAtFinish', () => {
  it('drops a repo with a known base, no commits and nothing uncommitted', () => {
    expect(dropsAtFinish({ baseKnown: true, commits: 0, uncommitted: 0 })).toBe(
      true,
    );
  });

  it('keeps a repo with commits, uncommitted files or an unknown base', () => {
    expect(dropsAtFinish({ baseKnown: true, commits: 2, uncommitted: 0 })).toBe(
      false,
    );
    expect(dropsAtFinish({ baseKnown: true, commits: 0, uncommitted: 1 })).toBe(
      false,
    );
    expect(
      dropsAtFinish({ baseKnown: false, commits: 0, uncommitted: 0 }),
    ).toBe(false);
  });
});
