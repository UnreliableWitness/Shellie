import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  DiscardedCleanup,
  PendingCleanup,
  Task,
} from '../../shared/types';
import {
  cleanupTempRepos,
  commitFile,
  git,
  makeRepo,
} from '../test-helpers/gitRepo';
import { GitClient, GitError } from './GitClient';
import {
  cleanupErrorCode,
  GIVE_UP_MS,
  removeWorkspace,
  WorktreeCleanup,
} from './worktreeCleanup';

const errno = (code: string, message = code) =>
  Object.assign(new Error(message), { code });

/** A fake git and file system: `held` folders cannot be removed until released. */
function fakeGit() {
  const folders = new Set<string>();
  const branches = new Set<string>();
  const held = new Map<string, Error>();
  const calls: string[] = [];
  return {
    folders,
    branches,
    held,
    calls,
    exists: async (p: string) => folders.has(p),
    git: {
      worktreeRemove: async (_repo: string, p: string) => {
        calls.push(`remove ${p}`);
        const e = held.get(p);
        if (e) throw e;
        folders.delete(p);
      },
      worktreePrune: async () => {
        calls.push('prune');
      },
      branchExists: async (_repo: string, b: string) => branches.has(b),
      deleteBranch: async (_repo: string, b: string) => {
        calls.push(`branch -D ${b}`);
        branches.delete(b);
      },
    },
  };
}

const T0 = Date.parse('2026-10-23T08:00:00Z');

afterAll(cleanupTempRepos);

describe('cleanupErrorCode', () => {
  it('names the fs code, also through a cause', () => {
    expect(cleanupErrorCode(errno('EBUSY'))).toBe('EBUSY');
    expect(
      cleanupErrorCode(new Error('wrapped', { cause: errno('EPERM') })),
    ).toBe('EPERM');
  });
  it('tells a folder git found in use from other git failures', () => {
    expect(
      cleanupErrorCode(
        new GitError(['worktree', 'remove'], 'error: Permission denied', 1),
      ),
    ).toBe('in-use');
    expect(
      cleanupErrorCode(new GitError(['worktree'], 'fatal: something', 128)),
    ).toBe('git');
    expect(cleanupErrorCode(new Error('x'))).toBe('other');
  });
});

describe('removeWorkspace', () => {
  const ws = {
    workspaceId: 'home',
    repoPath: '/repo',
    worktreePath: '/wt',
    branch: 'feature/x',
  };

  it('removes the folder, prunes and deletes the branch', async () => {
    const f = fakeGit();
    f.folders.add('/wt');
    f.branches.add('feature/x');
    const left = await removeWorkspace(f.git, ws, {
      exists: f.exists,
      now: () => T0,
    });
    expect(left).toBeNull();
    expect(f.calls).toEqual(['remove /wt', 'prune', 'branch -D feature/x']);
  });

  it('keeps the branch when asked to', async () => {
    const f = fakeGit();
    f.folders.add('/wt');
    f.branches.add('feature/x');
    await removeWorkspace(
      f.git,
      { ...ws, branch: null },
      { exists: f.exists, now: () => T0 },
    );
    expect(f.branches.has('feature/x')).toBe(true);
  });

  it('returns what is left, with the code, instead of throwing, when a process holds a file', async () => {
    const f = fakeGit();
    f.folders.add('/wt');
    f.branches.add('feature/x');
    f.held.set('/wt', errno('EPERM', 'Could not delete /wt: EPERM'));
    const left = await removeWorkspace(f.git, ws, {
      exists: f.exists,
      now: () => T0,
    });
    expect(left).toEqual<PendingCleanup>({
      ...ws,
      since: new Date(T0).toISOString(),
      attempts: 1,
      error: 'Could not delete /wt: EPERM',
      code: 'EPERM',
      notified: false,
    });
    // The branch waits for the folder: git refuses to delete a branch a worktree still has.
    expect(f.calls).toEqual(['remove /wt']);
  });

  it('carries on when the removal failed but the folder is gone anyway', async () => {
    const f = fakeGit();
    f.branches.add('feature/x');
    f.held.set('/wt', errno('ENOENT'));
    // exists says no from the start: removal is skipped, the branch goes.
    const left = await removeWorkspace(f.git, ws, {
      exists: f.exists,
      now: () => T0,
    });
    expect(left).toBeNull();
    expect(f.branches.has('feature/x')).toBe(false);
  });

  it('still deletes uncommitted files and unpushed commits: the user chose that at Finish or Discard (#244)', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', wt);
    commitFile(wt, 'work.txt', 'work');
    writeFileSync(path.join(wt, 'draft.txt'), 'draft');
    const real = new GitClient();
    const left = await removeWorkspace(
      real,
      { ...ws, repoPath: repo, worktreePath: wt },
      { now: () => T0 },
    );
    expect(left).toBeNull();
    expect(existsSync(wt)).toBe(false);
    expect(await real.branchExists(repo, 'feature/x')).toBe(false);
  });
});

const doneTask = (pending: PendingCleanup[], over: Partial<Task> = {}) =>
  ({
    id: 't1',
    status: 'done',
    pendingCleanup: pending,
    ...over,
  }) as Task;

const entry = (over: Partial<PendingCleanup> = {}): PendingCleanup => ({
  workspaceId: 'home',
  repoPath: '/repo',
  worktreePath: '/wt',
  branch: 'feature/x',
  since: new Date(T0).toISOString(),
  attempts: 1,
  error: 'EPERM',
  code: 'EPERM',
  notified: false,
  ...over,
});

function harness(task: Task, now: () => number) {
  const f = fakeGit();
  const tasks = [task];
  const notices: string[] = [];
  const events: { name: string; props?: unknown; m?: unknown }[] = [];
  const busy = new Set<string>();
  const cleanup = new WorktreeCleanup({
    git: f.git,
    exists: f.exists,
    now,
    tasks: () => tasks,
    claim: (id) => {
      if (busy.has(id)) return false;
      busy.add(id);
      return true;
    },
    release: (id) => busy.delete(id),
    mutate: async (id, fn) => {
      const t = tasks.find((x) => x.id === id);
      if (t) fn(t);
    },
    notice: (m) => notices.push(m),
    event: (name, props, m) => events.push({ name, props, m }),
  });
  return { f, tasks, notices, events, busy, cleanup };
}

describe('WorktreeCleanup', () => {
  it('finishes the cleanup once the folder is free, and reports it by code only', async () => {
    const h = harness(doneTask([entry()]), () => T0 + 10 * 60_000);
    h.f.folders.add('/wt');
    h.f.branches.add('feature/x');
    await h.cleanup.retryAll();
    expect(h.tasks[0].pendingCleanup).toEqual([]);
    expect(h.f.folders.has('/wt')).toBe(false);
    expect(h.f.branches.has('feature/x')).toBe(false);
    expect(h.events).toEqual([
      {
        name: 'cleanup.done',
        props: { code: 'EPERM' },
        m: { attempts: 2, minutes: 10 },
      },
    ]);
    expect(h.notices).toEqual([]);
    expect(h.busy.size).toBe(0);
  });

  it('counts a failed retry quietly, then gives one notice after a day', async () => {
    let now = T0 + 60_000;
    const h = harness(doneTask([entry()]), () => now);
    h.f.folders.add('/wt');
    h.f.held.set('/wt', errno('EBUSY', 'resource busy'));
    await h.cleanup.retryAll();
    expect(h.tasks[0].pendingCleanup[0]).toMatchObject({
      attempts: 2,
      code: 'EBUSY',
      error: 'resource busy',
      notified: false,
    });
    expect(h.notices).toEqual([]);
    now = T0 + GIVE_UP_MS + 1;
    await h.cleanup.retryAll();
    await h.cleanup.retryAll();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('/wt');
    expect(h.tasks[0].pendingCleanup[0]).toMatchObject({
      attempts: 4,
      notified: true,
    });
    expect(h.events.filter((e) => e.name === 'cleanup.gaveUp')).toEqual([
      { name: 'cleanup.gaveUp', props: { code: 'EBUSY' }, m: { attempts: 3 } },
    ]);
  });

  it('leaves a task alone while it is busy or no longer done (a reopen)', async () => {
    const h = harness(doneTask([entry()]), () => T0);
    h.f.folders.add('/wt');
    h.busy.add('t1');
    await h.cleanup.retryAll();
    expect(h.f.calls).toEqual([]);
    h.busy.clear();
    h.tasks[0].status = 'ready';
    await h.cleanup.retryAll();
    expect(h.f.calls).toEqual([]);
  });

  it('retries one task on demand and says whether anything is left', async () => {
    const h = harness(doneTask([entry()]), () => T0);
    h.f.folders.add('/wt');
    h.f.held.set('/wt', errno('EPERM'));
    expect(await h.cleanup.retryTask('t1')).toBe(false);
    h.f.held.clear();
    expect(await h.cleanup.retryTask('t1')).toBe(true);
  });
});

describe('WorktreeCleanup: discarded tasks (#124)', () => {
  function discardHarness(list: DiscardedCleanup[], tasks: Task[] = []) {
    const f = fakeGit();
    const state = { list };
    const notices: string[] = [];
    const events: string[] = [];
    const cleanup = new WorktreeCleanup({
      git: f.git,
      exists: f.exists,
      now: () => T0 + 5 * 60_000,
      tasks: () => tasks,
      claim: () => true,
      release: () => undefined,
      mutate: async () => undefined,
      notice: (m) => notices.push(m),
      event: (name) => events.push(name),
      discarded: {
        list: () => state.list,
        mutate: async (fn) => {
          state.list = fn(state.list);
        },
      },
    });
    return { f, state, notices, events, cleanup };
  }

  it('retries what a discarded task left until it is gone', async () => {
    const h = discardHarness([{ ...entry(), taskId: 'gone' }]);
    h.f.folders.add('/wt');
    h.f.branches.add('feature/x');
    h.f.held.set('/wt', errno('EBUSY'));
    await h.cleanup.retryAll();
    expect(h.state.list).toEqual([
      expect.objectContaining({ taskId: 'gone', attempts: 2, code: 'EBUSY' }),
    ]);
    h.f.held.delete('/wt');
    await h.cleanup.retryAll();
    expect(h.state.list).toEqual([]);
    expect(h.f.folders.has('/wt')).toBe(false);
    expect(h.f.branches.has('feature/x')).toBe(false);
    expect(h.events).toEqual(['cleanup.done']);
  });

  it('never touches a folder a live task uses now: that leftover is dropped', async () => {
    const live = {
      id: 'new',
      status: 'ready',
      repoId: 'r',
      branch: 'feature/x',
      worktreePath: '/wt',
      baseRef: 'main',
      baseSha: null,
      summary: null,
      pullRequest: null,
      reopen: null,
      homeDropped: false,
      extraWorkspaces: [],
      pendingCleanup: [],
    } as unknown as Task;
    const h = discardHarness([{ ...entry(), taskId: 'gone' }], [live]);
    h.f.folders.add('/wt');
    await h.cleanup.retryAll();
    expect(h.f.calls).toEqual([]);
    expect(h.f.folders.has('/wt')).toBe(true);
    expect(h.state.list).toEqual([]);
  });

  it('keeps a leftover added while a retry ran', async () => {
    const h = discardHarness([{ ...entry(), taskId: 'a' }]);
    h.f.folders.add('/wt');
    const later = { ...entry({ worktreePath: '/wt2' }), taskId: 'b' };
    const realRemove = h.f.git.worktreeRemove;
    h.f.git.worktreeRemove = async (r: string, p: string) => {
      h.state.list = [...h.state.list, later];
      return realRemove(r, p);
    };
    await h.cleanup.retryAll();
    expect(h.state.list).toEqual([later]);
  });
});
