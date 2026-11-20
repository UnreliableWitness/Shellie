import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../services/GitClient';
import { cleanupTempRepos, git, makeRepo } from '../test-helpers/gitRepo';
import {
  changedPaths,
  commitFiles,
  commitSubject,
  nextDreamId,
  removeDream,
  unattendedConfig,
} from './dreamGit';

const NOW = new Date(2026, 10, 20, 12).getTime();
const gc = new GitClient();

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempRepos();
});

/** A hook that leaves a marker file next to the repo when it runs. */
function hook(repo: string, name: string): string {
  const marker = path.join(path.dirname(repo), `${name}.ran`);
  const file = path.join(repo, '.git', 'hooks', name);
  writeFileSync(file, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(file, 0o755);
  return marker;
}

describe('dreamGit', () => {
  it('lists changed, added and deleted paths, untracked folders file by file', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, 'gone.md'), 'x');
    git(repo, 'add', 'gone.md');
    git(repo, 'commit', '-q', '-m', 'gone');
    writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    rmSync(path.join(repo, 'gone.md'));
    mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(repo, 'a', 'b', 'new file é.md'), 'y');
    expect(await changedPaths(gc, repo, [])).toEqual([
      'README.md',
      'a/b/new file é.md',
      'gone.md',
    ]);
  });

  it('commits exactly the given files, without the repo hooks', async () => {
    const repo = makeRepo();
    const pre = hook(repo, 'pre-commit');
    const post = hook(repo, 'post-commit');
    writeFileSync(path.join(repo, 'one.md'), '1');
    writeFileSync(path.join(repo, 'two.md'), '2');
    const hooks = path.join(path.dirname(repo), 'nohooks');
    mkdirSync(hooks);
    const sha = await commitFiles(gc, repo, {
      files: ['one.md'],
      subject: commitSubject('x'.repeat(80)),
      body: 'Why.',
      config: unattendedConfig(hooks),
    });
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(sha);
    expect(git(repo, 'log', '-1', '--format=%s%n%b', sha).trim()).toBe(
      `dream: ${'x'.repeat(72)}\nWhy.`,
    );
    expect(git(repo, 'show', '--name-only', '--format=', sha).trim()).toBe(
      'one.md',
    );
    expect(git(repo, 'status', '--porcelain').trim()).toBe('?? two.md');
    expect(git(repo, 'log', '-1', '--format=%an <%ae>').trim()).toBe(
      'Shellie tests <tests@shellie.local>',
    );
    expect(existsSync(pre) || existsSync(post)).toBe(false);
  });

  it('commits as Shellie Dreams when the repo has no author', async () => {
    const repo = makeRepo();
    const empty = path.join(path.dirname(repo), 'empty.gitconfig');
    writeFileSync(empty, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', empty);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    git(repo, 'config', '--unset', 'user.name');
    git(repo, 'config', '--unset', 'user.email');
    writeFileSync(path.join(repo, 'one.md'), '1');
    await commitFiles(gc, repo, {
      files: ['one.md'],
      subject: 'dream: x',
      body: '',
      config: [],
    });
    expect(git(repo, 'log', '-1', '--format=%an <%ae>').trim()).toBe(
      'Shellie Dreams <dreams@shellie.invalid>',
    );
  });

  it('skips a number whose branch or folder exists', async () => {
    const repo = makeRepo();
    const dir = path.join(path.dirname(repo), 'dreams');
    git(repo, 'branch', 'dream/2026-11-20-1');
    mkdirSync(path.join(dir, '2026-11-20-2'), { recursive: true });
    expect(await nextDreamId(gc, repo, dir, NOW)).toBe('2026-11-20-3');
  });

  it('adds a worktree without the post-checkout hook when told, and removes a half-made one', async () => {
    const repo = makeRepo();
    const marker = hook(repo, 'post-checkout');
    const dir = path.join(path.dirname(repo), 'dreams', 'd1');
    const hooks = path.join(dir, 'hooks');
    mkdirSync(hooks, { recursive: true });
    const wt = path.join(dir, 'wt');
    await gc.worktreeAdd(repo, {
      branch: 'dream/d1',
      path: wt,
      baseRef: 'main',
      config: unattendedConfig(hooks),
    });
    expect(existsSync(marker)).toBe(false);
    // Half made: git no longer knows the worktree, but its folder and branch are there.
    rmSync(path.join(wt, '.git'));
    await removeDream(gc, repo, { dir, worktree: wt, branch: 'dream/d1' });
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, 'branch', '--list', 'dream/*').trim()).toBe('');
    expect(
      (await gc.worktreeList(repo)).map((w) => path.basename(w.path)),
    ).toEqual(['repo']);
  });
});
