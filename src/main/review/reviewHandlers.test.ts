// src/main/review/reviewHandlers.test.ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DocsWatcher } from '../docs/DocsWatcher';
import { GitClient } from '../services/GitClient';
import {
  cleanupTempRepos,
  commitFile,
  git,
  makeRepo,
} from '../test-helpers/gitRepo';
import { GitDirWatcher } from './GitDirWatcher';
import { createReviewHandlers } from './reviewHandlers';
import { ReviewService } from './ReviewService';
import { ReviewStore } from './ReviewStore';
import { testTask } from './testTask';

afterAll(cleanupTempRepos);

function setup() {
  const repo = makeRepo();
  const baseSha = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'checkout', '-q', '-b', 'task');
  commitFile(repo, 'a.ts', 'a\n');
  const task = testTask({ worktreePath: repo, baseSha });
  const gitClient = new GitClient();
  const changed = vi.fn();
  const docsWatcher = new DocsWatcher(() => undefined, 20);
  const gitDirWatcher = new GitDirWatcher(
    (wt) => gitClient.gitDir(wt),
    changed,
    20,
  );
  const h = createReviewHandlers({
    taskById: () => task,
    review: new ReviewService({
      git: gitClient,
      store: new ReviewStore(
        mkdtempSync(path.join(os.tmpdir(), 'shellie-rh-')),
      ),
      repoName: () => 'web',
      collapseOf: async () => [],
    }),
    docsWatcher,
    gitDirWatcher,
  });
  return { repo, h, changed, docsWatcher, gitDirWatcher };
}

describe('review handlers', () => {
  it('lists files for a valid scope', async () => {
    const { h } = setup();
    const r = await h['review:files']('t1', { kind: 'all' });
    expect(r.repos[0].files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('rejects a bad commit ref', async () => {
    const { h } = setup();
    await expect(
      h['review:files']('t1', {
        kind: 'commits',
        workspaceId: 'home',
        from: 'HEAD; rm',
        to: 'abc1234',
      } as never),
    ).rejects.toThrow();
  });

  it('rejects a path outside the worktree', async () => {
    const { h } = setup();
    await expect(
      h['review:file'](
        't1',
        'home',
        { path: '../x', status: 'M', binary: false },
        { kind: 'all' },
      ),
    ).rejects.toThrow('Outside the worktree');
  });

  it('discards a listed file and validates the input', async () => {
    const { h, repo } = setup();
    await expect(
      h['review:discard']('t1', 'home', '../x', { kind: 'all' }),
    ).rejects.toThrow('Outside the worktree');
    await expect(
      h['review:discard']('t1', 'home', 'a.ts', { kind: 'nope' } as never),
    ).rejects.toThrow();
    await h['review:discard']('t1', 'home', 'a.ts', { kind: 'all' });
    expect(existsSync(path.join(repo, 'a.ts'))).toBe(false);
  });

  it('validates comment input', async () => {
    const { h } = setup();
    await expect(
      h['review:addComment']('t1', {
        workspaceId: 'home',
        path: 'a.ts',
        side: 'after',
        startLine: 0,
        endLine: 1,
        text: 'x',
      }),
    ).rejects.toThrow();
    const s = await h['review:addComment']('t1', {
      workspaceId: 'home',
      path: 'a.ts',
      side: 'after',
      startLine: 1,
      endLine: 1,
      text: 'x',
    });
    expect(s.comments).toHaveLength(1);
  });

  it('watch holds both watchers and reports commits', async () => {
    const { h, repo, changed, gitDirWatcher } = setup();
    expect(await h['review:watch']('t1', true)).toEqual({ live: true });
    commitFile(repo, 'b.ts', 'b\n');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('t1'), {
      timeout: 3000,
    });
    expect(await h['review:watch']('t1', false)).toEqual({ live: false });
    const stop = vi.spyOn(gitDirWatcher, 'stop');
    await h['review:watch']('t1', false);
    expect(stop).toHaveBeenCalledWith('t1');
  });

  it('watch falls back to polling when the worktree is missing', async () => {
    const { h, repo, docsWatcher, gitDirWatcher } = setup();
    rmSync(repo, { recursive: true, force: true });
    const files = vi.spyOn(docsWatcher, 'start');
    const gitDir = vi.spyOn(gitDirWatcher, 'start');
    expect(await h['review:watch']('t1', true)).toEqual({ live: false });
    expect(files).not.toHaveBeenCalled();
    expect(gitDir).not.toHaveBeenCalled();
  });
});
