import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  addOrigin,
  cleanupTempRepos,
  commitFile,
  git,
  makeRepo,
} from '../test-helpers/gitRepo';
import { GitAuthError, GitClient, GitError } from './GitClient';
import { extraHeaderEnv } from './gitAuth';

const client = new GitClient();

afterAll(cleanupTempRepos);

describe('GitClient', () => {
  it('returns toplevel and commonDir in native path form', async () => {
    const c = new GitClient();
    const spy = vi.spyOn(c, 'run').mockResolvedValue('C:/x/y\n');
    expect(await c.toplevel('/anywhere')).toBe(path.resolve('C:/x/y'));
    expect(await c.commonDir('/anywhere')).toBe(
      path.resolve('/anywhere', 'C:/x/y'),
    );
    spy.mockRestore();
  });

  it('worktreeRemove retries while Windows still holds the folder', async () => {
    const waits: number[] = [];
    const c = new GitClient(async (ms) => {
      waits.push(ms);
    });
    let calls = 0;
    const spy = vi.spyOn(c, 'run').mockImplementation(async (_cwd, args) => {
      calls++;
      if (calls === 1)
        throw new GitError(
          args,
          "error: failed to delete 'C:/w': Permission denied",
          128,
        );
      if (calls === 2)
        throw new GitError(
          args,
          "error: failed to delete 'C:/w': Directory not empty",
          128,
        );
      return '';
    });
    await c.worktreeRemove('/repo', '/w', true);
    expect(calls).toBe(3);
    expect(waits).toEqual([50, 100]);
    spy.mockRestore();
  });

  it('worktreeRemove keeps retrying for about 5 s before giving up', async () => {
    const waits: number[] = [];
    const c = new GitClient(async (ms) => {
      waits.push(ms);
    });
    const spy = vi.spyOn(c, 'run').mockImplementation(async (_cwd, args) => {
      throw new GitError(
        args,
        "error: failed to delete 'C:/w': Permission denied",
        128,
      );
    });
    await expect(c.worktreeRemove('/repo', '/w', true)).rejects.toThrow(
      /Permission denied/,
    );
    expect(waits).toEqual([50, 100, 200, 400, 800, 1600, 1850]);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(5000);
    spy.mockRestore();
  });

  it('worktreeRemove does not retry other failures', async () => {
    const waits: number[] = [];
    const c = new GitClient(async (ms) => {
      waits.push(ms);
    });
    const spy = vi.spyOn(c, 'run').mockImplementation(async (_cwd, args) => {
      throw new GitError(args, "fatal: '/w' is not a working tree", 128);
    });
    await expect(c.worktreeRemove('/repo', '/w', true)).rejects.toThrow(
      /not a working tree/,
    );
    expect(waits).toEqual([]);
    spy.mockRestore();
  });

  it('finds the toplevel and returns null outside a repo', async () => {
    const repo = makeRepo();
    expect(await client.toplevel(repo)).toBe(repo);
    expect(await client.toplevel(path.join(repo, '..'))).toBeNull();
  });

  it('reports branch existence and validity', async () => {
    const repo = makeRepo();
    expect(await client.branchExists(repo, 'main')).toBe(true);
    expect(await client.branchExists(repo, 'feature/x')).toBe(false);
    expect(
      await client.validBranchName(repo, 'feature/48213-save-address'),
    ).toBe(true);
    expect(await client.validBranchName(repo, 'bad name')).toBe(false);
    expect(await client.validBranchName(repo, 'bad..name')).toBe(false);
    expect(await client.validBranchName(repo, '-bad')).toBe(false);
    expect(await client.validBranchName(repo, '@{-1}')).toBe(false);
    expect(await client.validBranchName(repo, 'feature/trailing/')).toBe(false);
  });

  it('adds a worktree on a new branch from a base ref, then removes it', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'repo.worktrees', 'x');
    await client.worktreeAdd(repo, {
      branch: 'feature/x',
      path: wt,
      baseRef: 'main',
    });
    expect(existsSync(path.join(wt, 'README.md'))).toBe(true);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'feature/x',
    );
    await client.worktreeRemove(repo, wt, true);
    expect(existsSync(wt)).toBe(false);
    await client.deleteBranch(repo, 'feature/x');
    expect(await client.branchExists(repo, 'feature/x')).toBe(false);
  });

  it('wraps failures in GitError with stderr', async () => {
    const repo = makeRepo();
    await expect(
      client.worktreeAdd(repo, {
        branch: 'y',
        path: path.join(repo, '..', 'y'),
        baseRef: 'nope',
      }),
    ).rejects.toBeInstanceOf(GitError);
    await expect(
      client.worktreeAdd(repo, {
        branch: 'y',
        path: path.join(repo, '..', 'y'),
        baseRef: 'nope',
      }),
    ).rejects.toThrow(/nope/);
  });

  it('fetches when the base ref names a known remote, and skips otherwise', async () => {
    const repo = makeRepo();
    expect(await client.fetch(repo, 'main')).toBe(false);
    expect(await client.fetch(repo, 'origin/main')).toBe(false);
    addOrigin(repo);
    expect(await client.fetch(repo, 'origin/main')).toBe(true);
    expect(await client.remotes(repo)).toEqual(['origin']);
  });

  it('summarises ahead, behind and changed files with an upstream', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    commitFile(repo, 'a.txt', 'a');
    commitFile(repo, 'b.txt', 'b');
    writeFileSync(path.join(repo, 'README.md'), 'changed');
    writeFileSync(path.join(repo, 'new.txt'), 'new');
    const s = await client.summary(repo, 'origin/main');
    expect(s.branch).toBe('main');
    expect(s.hasUpstream).toBe(true);
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(0);
    expect(s.files).toEqual([
      { status: 'M', path: 'README.md' },
      { status: '?', path: 'new.txt' },
    ]);
  });

  it('counts commits since the base ref when there is no upstream', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    await client.worktreeAdd(repo, {
      branch: 'feature/z',
      path: wt,
      baseRef: 'main',
    });
    git(wt, 'config', 'user.email', 'tests@shellie.local');
    git(wt, 'config', 'user.name', 'Shellie tests');
    commitFile(wt, 'z.txt', 'z');
    const s = await client.summary(wt, 'main');
    expect(s.branch).toBe('feature/z');
    expect(s.hasUpstream).toBe(false);
    expect(s.ahead).toBe(1);
    expect(s.files).toEqual([]);
  });

  it('reports HEAD for a detached worktree', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt3');
    await client.worktreeAdd(repo, {
      branch: 'feature/d',
      path: wt,
      baseRef: 'main',
    });
    git(wt, 'checkout', '-q', '--detach');
    const s = await client.summary(wt, 'main');
    expect(s.branch).toBe('HEAD');
    expect(s.hasUpstream).toBe(false);
  });

  it('reports the branch name in a repo with no commits', async () => {
    const repo = makeRepo();
    const empty = path.join(path.dirname(repo), 'empty');
    git(path.dirname(repo), 'init', '-q', '-b', 'main', 'empty');
    const s = await client.summary(empty, 'main');
    expect(s.branch).toBe('main');
    expect(s.files).toEqual([]);
  });

  it('gives a non-empty reason when git cannot be spawned', async () => {
    const err = await client
      .run('/nonexistent-dir-shellie', ['status'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).toMatch(/ENOENT|spawn|no such file/i);
    expect((err as GitError).message.length).toBeGreaterThan(
      'git status failed'.length + 5,
    );
  });

  it('returns the common git dir for a worktree', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt2');
    await client.worktreeAdd(repo, {
      branch: 'feature/c',
      path: wt,
      baseRef: 'main',
    });
    expect(await client.commonDir(wt)).toBe(path.join(repo, '.git'));
  });

  it('runs worktree add, remove and prune with core.longpaths on every OS', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'longpaths');
    const spy = vi.spyOn(client, 'run');
    await client.worktreeAdd(repo, {
      branch: 'feature/lp',
      path: wt,
      baseRef: 'main',
    });
    await client.worktreeRemove(repo, wt, true);
    await client.worktreePrune(repo);
    const argsPerCall = spy.mock.calls.map(([, args]) => args);
    spy.mockRestore();
    expect(argsPerCall).toEqual([
      [
        '-c',
        'core.longpaths=true',
        'worktree',
        'add',
        '--no-track',
        '-b',
        'feature/lp',
        wt,
        'main',
      ],
      ['rev-parse', 'HEAD'],
      ['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', wt],
      ['-c', 'core.longpaths=true', 'worktree', 'prune'],
    ]);
  });

  it('summarises a finished branch: commits since the merge base, diff stat, local', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt-sum');
    await client.worktreeAdd(repo, {
      branch: 'feature/sum',
      path: wt,
      baseRef: 'main',
    });
    // main moves on after the branch left it; that must not count.
    commitFile(repo, 'later.txt', 'later\n');
    commitFile(wt, 'a.txt', 'one\ntwo\n', 'Add a');
    writeFileSync(path.join(wt, 'README.md'), 'changed\n');
    git(wt, 'commit', '-q', '-am', 'Change the readme');
    const s = await client.finishSummary(wt, {
      baseRef: 'main',
      baseSha: null,
      branch: 'feature/sum',
    });
    expect(s.commitCount).toBe(2);
    expect(s.commits.map((c) => c.subject)).toEqual([
      'Add a',
      'Change the readme',
    ]);
    expect(s.commits[0].sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(s).toMatchObject({
      filesChanged: 2,
      insertions: 3,
      deletions: 1,
      pushed: false,
      upstream: null,
    });
  });

  it('gives the branch log with bodies, the stat and the diff without lock files', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt-changes');
    const baseSha = await client.worktreeAdd(repo, {
      branch: 'feature/changes',
      path: wt,
      baseRef: 'main',
    });
    commitFile(repo, 'later.txt', 'later\n');
    writeFileSync(path.join(wt, 'a.txt'), 'one\n');
    writeFileSync(path.join(wt, 'package-lock.json'), '{"lock":true}\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'Add a', '-m', 'Because b needs it.');
    const c = await client.branchChanges(wt, { baseRef: 'main', baseSha });
    expect(c).not.toBeNull();
    expect(c!.log).toMatch(/^- [0-9a-f]{7,} Add a\n\s+Because b needs it\./);
    expect(c!.stat).toContain('a.txt');
    expect(c!.diff).toContain('+one');
    expect(c!.diff).not.toContain('package-lock.json');
    expect(c!.diff).not.toContain('later');
    expect(
      await client.branchChanges(wt, { baseRef: 'nope', baseSha: null }),
    ).toBeNull();
  });

  it('worktreeAdd returns the commit the branch starts from', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt-sha');
    const sha = await client.worktreeAdd(repo, {
      branch: 'feature/sha',
      path: wt,
      baseRef: 'main',
    });
    expect(sha).toBe(git(repo, 'rev-parse', 'main').trim());
  });

  it('measures from the recorded base commit, so a merged and fetched PR still lists its commits', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt-merged');
    const baseSha = await client.worktreeAdd(repo, {
      branch: 'feature/merged',
      path: wt,
      baseRef: 'main',
    });
    commitFile(wt, 'a.txt', 'one\n', 'Add a');
    // The PR completes with a merge commit, and main is pulled: HEAD is now an ancestor of the base.
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge PR', 'feature/merged');
    const fallback = await client.finishSummary(wt, {
      baseRef: 'main',
      baseSha: null,
      branch: 'feature/merged',
    });
    expect(fallback.commitCount).toBe(0);
    const s = await client.finishSummary(wt, {
      baseRef: 'main',
      baseSha,
      branch: 'feature/merged',
    });
    expect(s).toMatchObject({
      baseKnown: true,
      commitCount: 1,
      commits: [{ subject: 'Add a' }],
      filesChanged: 1,
      insertions: 1,
    });
  });

  it('lists no commits when neither the recorded base nor the base ref resolves', async () => {
    const repo = makeRepo();
    for (let i = 0; i < 3; i++)
      git(repo, 'commit', '-q', '--allow-empty', '-m', `Old ${i}`);
    const s = await client.finishSummary(repo, {
      baseRef: 'origin/gone',
      baseSha: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
    });
    expect(s).toMatchObject({
      baseKnown: false,
      commits: [],
      commitCount: 0,
      filesChanged: 0,
    });
  });

  it('does not make the base the upstream of a worktree branch made from origin/<base>', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const wt = path.join(path.dirname(repo), 'wt-notrack');
    await client.worktreeAdd(repo, {
      branch: 'feature/notrack',
      path: wt,
      baseRef: 'origin/main',
    });
    expect(() => git(wt, 'rev-parse', '--abbrev-ref', '@{u}')).toThrow();
    commitFile(wt, 'a.txt', 'a\n');
    const s = await client.finishSummary(wt, {
      baseRef: 'origin/main',
      baseSha: null,
      branch: 'feature/notrack',
    });
    expect(s).toMatchObject({ pushed: false, upstream: null });
    expect((await client.summary(wt, 'origin/main')).ahead).toBe(1);
  });

  it('counts a branch pushed without -u as pushed, by looking at origin/<branch>', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const wt = path.join(path.dirname(repo), 'wt-pushed');
    await client.worktreeAdd(repo, {
      branch: 'feature/pushed',
      path: wt,
      baseRef: 'origin/main',
    });
    // An upstream set to the base (old tasks, or a user's own config) must not decide the answer.
    git(wt, 'branch', '--set-upstream-to=origin/main');
    commitFile(wt, 'a.txt', 'a\n');
    git(wt, 'push', '-q', 'origin', 'feature/pushed');
    const s = await client.finishSummary(wt, {
      baseRef: 'origin/main',
      baseSha: null,
      branch: 'feature/pushed',
    });
    expect(s).toMatchObject({
      pushed: true,
      upstream: 'origin/feature/pushed',
    });
    commitFile(wt, 'b.txt', 'b\n');
    expect(
      await client.finishSummary(wt, {
        baseRef: 'origin/main',
        baseSha: null,
        branch: 'feature/pushed',
      }),
    ).toMatchObject({ pushed: false, upstream: 'origin/feature/pushed' });
  });

  it('reports a pushed branch with its upstream, and caps the list at 50 commits', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    git(repo, 'checkout', '-q', '-b', 'feature/many');
    for (let i = 1; i <= 52; i++)
      git(repo, 'commit', '-q', '--allow-empty', '-m', `Step ${i}`);
    git(repo, 'push', '-q', '-u', 'origin', 'feature/many');
    const s = await client.finishSummary(repo, {
      baseRef: 'origin/main',
      baseSha: null,
      branch: 'feature/many',
    });
    expect(s.commitCount).toBe(52);
    expect(s.commits).toHaveLength(50);
    // The newest 50, shown oldest first.
    expect(s.commits[0].subject).toBe('Step 3');
    expect(s.commits[49].subject).toBe('Step 52');
    expect(s).toMatchObject({
      filesChanged: 0,
      pushed: true,
      upstream: 'origin/feature/many',
    });
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'Not pushed');
    expect(
      (
        await client.finishSummary(repo, {
          baseRef: 'origin/main',
          baseSha: null,
          branch: 'feature/many',
        })
      ).pushed,
    ).toBe(false);
  });

  it('remoteUrl returns the remote URL, or null for an unknown remote', async () => {
    const repo = makeRepo();
    const bare = addOrigin(repo);
    expect(await client.remoteUrl(repo, 'origin')).toBe(bare);
    expect(await client.remoteUrl(repo, 'nope')).toBeNull();
  });

  it('push creates the remote branch and sets the upstream', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    git(repo, 'checkout', '-q', '-b', 'feature/p');
    commitFile(repo, 'p.txt', 'p');
    await client.push(repo, 'origin', 'feature/p');
    expect(git(repo, 'rev-parse', 'origin/feature/p').trim()).toBe(
      git(repo, 'rev-parse', 'HEAD').trim(),
    );
    expect(git(repo, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe(
      'origin/feature/p',
    );
  });

  it('push rejects with git stderr when the remote moved ahead', async () => {
    const repo = makeRepo();
    const bare = addOrigin(repo);
    git(repo, 'checkout', '-q', '-b', 'feature/q');
    commitFile(repo, 'q.txt', 'q');
    await client.push(repo, 'origin', 'feature/q');
    const other = path.join(path.dirname(repo), 'other');
    git(path.dirname(repo), 'clone', '-q', bare, other);
    git(other, 'config', 'user.email', 'tests@shellie.local');
    git(other, 'config', 'user.name', 'Shellie tests');
    git(other, 'checkout', '-q', 'feature/q');
    commitFile(other, 'o.txt', 'o');
    git(other, 'push', '-q', 'origin', 'feature/q');
    commitFile(repo, 'q2.txt', 'q2');
    const err = await client
      .push(repo, 'origin', 'feature/q')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('rejected');
    expect((err as Error).message).not.toMatch(/^git push/);
  });
});

describe('GitClient push from the GUI', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A repo with a branch to push and a pre-push hook; hooks inherit git's environment. */
  function repoWithHook(script: string): { repo: string; out: string } {
    const repo = makeRepo();
    addOrigin(repo);
    git(repo, 'checkout', '-q', '-b', 'feature/h');
    commitFile(repo, 'h.txt', 'h');
    const out = path.join(path.dirname(repo), 'hook-out.txt');
    const hook = path.join(repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, `#!/bin/sh\n${script.replace('OUT', out)}\n`);
    chmodSync(hook, 0o755);
    return { repo, out };
  }

  const isolate = () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_SSH_COMMAND', undefined);
    vi.stubEnv('GIT_SSH', undefined);
  };
  const hookEnv =
    'printf "%s|%s" "$GIT_SSH_COMMAND" "$GIT_TERMINAL_PROMPT" > "OUT"';

  it('runs ssh in batch mode and keeps the terminal prompt off', async () => {
    isolate();
    const { repo, out } = repoWithHook(hookEnv);
    await client.push(repo, 'origin', 'feature/h');
    expect(readFileSync(out, 'utf8')).toBe('ssh -o BatchMode=yes|0');
  });

  it("respects the user's own GIT_SSH_COMMAND", async () => {
    isolate();
    vi.stubEnv('GIT_SSH_COMMAND', 'my-ssh -i key');
    const { repo, out } = repoWithHook(hookEnv);
    await client.push(repo, 'origin', 'feature/h');
    expect(readFileSync(out, 'utf8')).toBe('my-ssh -i key|0');
  });

  it("respects the user's core.sshCommand", async () => {
    isolate();
    const { repo, out } = repoWithHook(hookEnv);
    git(repo, 'config', 'core.sshCommand', 'plink -batch');
    await client.push(repo, 'origin', 'feature/h');
    expect(readFileSync(out, 'utf8')).toBe('|0');
  });

  it('gives up on a push that hangs, with a hint about a credential prompt', async () => {
    isolate();
    const { repo } = repoWithHook('sleep 10');
    const c = new GitClient(undefined, { pushTimeoutMs: 300 });
    const started = Date.now();
    const err = await c
      .push(repo, 'origin', 'feature/h')
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((err as Error).message).toBe(
      'git push timed out after 0.3 s (a credential prompt may be waiting)',
    );
    // The hook's shell is gone too, so nothing holds the repo: on Windows a leftover process would lock it
    // for the rest of its 10 s sleep. The short retry only covers handles closing after the kill.
    rmSync(path.dirname(repo), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    expect(existsSync(repo)).toBe(false);
  });

  it('waits 120 s for a push by default', () => {
    expect(new GitClient().pushTimeoutMs).toBe(120_000);
  });
});

describe('GitClient worktree helpers', () => {
  it('branchCommits counts commits since the base and those no remote has (#124)', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'branch', 'feature/x');
    expect(await client.branchCommits(repo, 'feature/x', base)).toEqual({
      commits: 0,
      unpushed: 0,
    });
    git(repo, 'checkout', '-q', 'feature/x');
    commitFile(repo, 'a.txt', 'a');
    commitFile(repo, 'b.txt', 'b');
    expect(await client.branchCommits(repo, 'feature/x', base)).toEqual({
      commits: 2,
      unpushed: 2,
    });
    git(repo, 'push', '-q', 'origin', 'HEAD~1:refs/heads/feature/x');
    git(repo, 'fetch', '-q', 'origin');
    expect(await client.branchCommits(repo, 'feature/x', base)).toEqual({
      commits: 2,
      unpushed: 1,
    });
    expect(await client.branchCommits(repo, 'gone', base)).toEqual({
      commits: 0,
      unpushed: 0,
    });
  });

  it('branchCommits leaves local-only base commits out of the unpushed count (#124)', async () => {
    const repo = makeRepo();
    commitFile(repo, 'local.txt', 'only here');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'branch', 'feature/y');
    expect(await client.branchCommits(repo, 'feature/y', base)).toEqual({
      commits: 0,
      unpushed: 0,
    });
  });

  it('worktreeRemove deletes a worktree git half removed (#87)', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt-half');
    git(repo, 'worktree', 'add', '-q', '-b', 'half', wt);
    writeFileSync(path.join(wt, 'left.txt'), 'x');
    // What a failed `worktree remove` leaves: the folder without its .git file, still registered.
    rmSync(path.join(wt, '.git'));
    await expect(
      client.run(repo, ['worktree', 'remove', '--force', wt]),
    ).rejects.toThrow(GitError);
    await client.worktreeRemove(repo, wt, true);
    expect(existsSync(wt)).toBe(false);
    expect((await client.worktreeList(repo)).map((w) => w.path)).toEqual([
      repo,
    ]);
    expect(existsSync(path.join(repo, 'README.md'))).toBe(true);
  });

  it('worktreeRemove deletes what git left in <repo>.worktrees after dropping the registration (#87)', async () => {
    const repo = makeRepo();
    const wt = path.join(`${repo}.worktrees`, 'left');
    git(repo, 'worktree', 'add', '-q', '-b', 'left', wt);
    writeFileSync(path.join(wt, 'left.txt'), 'x');
    // Git on Windows removes the .git file and the registration, then stops at a name it cannot delete.
    rmSync(path.join(wt, '.git'));
    git(repo, 'worktree', 'prune');
    expect(await client.worktreeList(repo)).toHaveLength(1);
    await client.worktreeRemove(repo, wt, true);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(`${repo}.worktrees`)).toBe(true);
  });

  it('worktreeRemove leaves a folder in <repo>.worktrees that is still a checkout', async () => {
    const repo = makeRepo();
    const clone = path.join(`${repo}.worktrees`, 'clone');
    mkdirSync(`${repo}.worktrees`);
    git(`${repo}.worktrees`, 'clone', '-q', repo, 'clone');
    await expect(client.worktreeRemove(repo, clone, true)).rejects.toThrow();
    expect(existsSync(path.join(clone, 'README.md'))).toBe(true);
    await expect(
      client.worktreeRemove(repo, `${repo}.worktrees`, true),
    ).rejects.toThrow();
    expect(existsSync(path.join(clone, 'README.md'))).toBe(true);
  });

  it('worktreeRemove never deletes a folder that is not a linked worktree', async () => {
    const repo = makeRepo();
    const other = path.join(path.dirname(repo), 'not-a-worktree');
    mkdirSync(other);
    writeFileSync(path.join(other, 'keep.txt'), 'x');
    await expect(client.worktreeRemove(repo, other, true)).rejects.toThrow();
    expect(existsSync(path.join(other, 'keep.txt'))).toBe(true);
    await expect(client.worktreeRemove(repo, repo, true)).rejects.toThrow();
    expect(existsSync(path.join(repo, 'README.md'))).toBe(true);
  });

  it('gives up on a worktree add that hangs, naming the step (#148)', async () => {
    const repo = makeRepo();
    // Hooks run through git's own sh, on Windows too.
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, '#!/bin/sh\nsleep 10\n');
    chmodSync(hook, 0o755);
    const c = new GitClient(undefined, { worktreeTimeoutMs: 300 });
    const started = Date.now();
    const err = await c
      .worktreeAdd(repo, {
        branch: 'hang',
        path: path.join(path.dirname(repo), 'wt-hang'),
        baseRef: 'main',
      })
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((err as Error).message).toBe(
      'git worktree add timed out after 0.3 s',
    );
  });

  it('removes the folder and branch a timed-out worktree add left behind', async () => {
    const repo = makeRepo();
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, '#!/bin/sh\nsleep 10\n');
    chmodSync(hook, 0o755);
    const c = new GitClient(undefined, { worktreeTimeoutMs: 300 });
    const wt = path.join(path.dirname(repo), 'wt-partial');
    await expect(
      c.worktreeAdd(repo, { branch: 'partial', path: wt, baseRef: 'main' }),
    ).rejects.toThrow('timed out');
    expect(existsSync(wt)).toBe(false);
    expect(await c.branchExists(repo, 'partial')).toBe(false);
  });

  it('waits 5 min for a worktree add by default', () => {
    expect(new GitClient().worktreeTimeoutMs).toBe(300_000);
  });

  it.runIf(process.platform === 'win32')(
    'worktreeRemove deletes a worktree with a nul file in it (#87)',
    async () => {
      const repo = makeRepo();
      const wt = path.join(`${repo}.worktrees`, 'wt-nul');
      git(repo, 'worktree', 'add', '-q', '-b', 'nul-file', wt);
      writeFileSync(path.toNamespacedPath(path.join(wt, 'nul')), 'x');
      await client.worktreeRemove(repo, wt, true);
      expect(existsSync(wt)).toBe(false);
      expect(await client.worktreeList(repo)).toHaveLength(1);
    },
  );

  it('worktreeList, mergeBase, defaultBaseRef and currentBranch', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt-list');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/y', wt);
    commitFile(wt, 'f.txt', 'f');
    const list = await client.worktreeList(repo);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ path: repo, branch: 'main' });
    expect(list[1]?.branch).toBe('feat/y');
    const fork = git(repo, 'rev-parse', 'main').trim();
    expect(await client.mergeBase(repo, 'main', 'feat/y')).toBe(fork);
    expect(await client.mergeBase(repo, 'main', 'nope')).toBeNull();
    expect(await client.defaultBaseRef(repo)).toBe('main');
    expect(await client.currentBranch(wt)).toBe('feat/y');
  });

  it('resolveBase prefers the recorded baseSha, else the merge base, else null', async () => {
    const repo = makeRepo();
    const first = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'checkout', '-q', '-b', 'task');
    commitFile(repo, 'a.txt', 'a\n');
    expect(
      await client.resolveBase(repo, { baseRef: 'main', baseSha: first }),
    ).toBe(first);
    expect(
      await client.resolveBase(repo, {
        baseRef: 'main',
        baseSha: 'f'.repeat(40),
      }),
    ).toBe(first);
    expect(
      await client.resolveBase(repo, { baseRef: 'nope', baseSha: null }),
    ).toBeNull();
  });

  it('gitDir is the worktree’s own git dir', async () => {
    const repo = makeRepo();
    const wt = path.join(path.dirname(repo), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'x', wt);
    const dir = await client.gitDir(wt);
    expect(dir).toBe(path.join(repo, '.git', 'worktrees', 'wt'));
  });

  describe('discardPaths', () => {
    const read = (repo: string, f: string) =>
      readFileSync(path.join(repo, f), 'utf8');
    const status = (repo: string) =>
      git(repo, 'status', '--porcelain=v1', '--untracked-files=all').trim();

    it('restores a modified file to HEAD, staged changes too', async () => {
      const repo = makeRepo();
      commitFile(repo, 'a.ts', 'one\n');
      writeFileSync(path.join(repo, 'a.ts'), 'staged\n');
      git(repo, 'add', 'a.ts');
      writeFileSync(path.join(repo, 'a.ts'), 'unstaged\n');
      await client.discardPaths(repo, 'HEAD', ['a.ts']);
      expect(read(repo, 'a.ts')).toBe('one\n');
      expect(status(repo)).toBe('');
    });

    it('brings back a deleted file', async () => {
      const repo = makeRepo();
      commitFile(repo, 'a.ts', 'one\n');
      rmSync(path.join(repo, 'a.ts'));
      await client.discardPaths(repo, 'HEAD', ['a.ts']);
      expect(read(repo, 'a.ts')).toBe('one\n');
      expect(status(repo)).toBe('');
    });

    it('deletes an untracked file and a staged new file', async () => {
      const repo = makeRepo();
      writeFileSync(path.join(repo, 'notes.txt'), 'x\n');
      writeFileSync(path.join(repo, 'new.ts'), 'y\n');
      git(repo, 'add', 'new.ts');
      await client.discardPaths(repo, 'HEAD', ['notes.txt', 'new.ts']);
      expect(existsSync(path.join(repo, 'notes.txt'))).toBe(false);
      expect(existsSync(path.join(repo, 'new.ts'))).toBe(false);
      expect(status(repo)).toBe('');
    });

    it('restores a file to an older base, leaving an uncommitted change', async () => {
      const repo = makeRepo();
      const base = git(repo, 'rev-parse', 'HEAD').trim();
      git(repo, 'checkout', '-q', '-b', 'task');
      writeFileSync(path.join(repo, 'README.md'), '# changed\n');
      git(repo, 'commit', '-q', '-am', 'change');
      commitFile(repo, 'added.ts', 'a\n');
      await client.discardPaths(repo, base, ['README.md', 'added.ts']);
      expect(read(repo, 'README.md')).toBe('# test\n');
      expect(existsSync(path.join(repo, 'added.ts'))).toBe(false);
      expect(git(repo, 'diff', '--name-only', base).trim()).toBe('');
      expect(status(repo).split('\n').sort()).toEqual([
        'D  added.ts',
        'M  README.md',
      ]);
    });

    // `*` cannot be in a Windows file name.
    it.skipIf(process.platform === 'win32')(
      'takes paths literally, not as pathspec patterns',
      async () => {
        const repo = makeRepo();
        commitFile(repo, 'a*.ts', 'star\n');
        commitFile(repo, 'ab.ts', 'b\n');
        writeFileSync(path.join(repo, 'a*.ts'), 'changed\n');
        writeFileSync(path.join(repo, 'ab.ts'), 'keep\n');
        await client.discardPaths(repo, 'HEAD', ['a*.ts']);
        expect(read(repo, 'a*.ts')).toBe('star\n');
        expect(read(repo, 'ab.ts')).toBe('keep\n');
      },
    );

    it('refuses paths outside the worktree and through a symlinked folder', async () => {
      const repo = makeRepo();
      const outside = path.join(path.dirname(repo), 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'x.txt'), 'keep\n');
      symlinkSync(outside, path.join(repo, 'link'));
      await expect(
        client.discardPaths(repo, 'HEAD', ['../outside/x.txt']),
      ).rejects.toThrow('Outside the worktree');
      await expect(
        client.discardPaths(repo, 'HEAD', ['link/x.txt']),
      ).rejects.toThrow('Outside the worktree');
      expect(read(outside, 'x.txt')).toBe('keep\n');
    });

    it('deletes an untracked symlink itself, not what it points to', async () => {
      const repo = makeRepo();
      const target = path.join(path.dirname(repo), 'target.txt');
      writeFileSync(target, 'keep\n');
      symlinkSync(target, path.join(repo, 'ln.txt'));
      await client.discardPaths(repo, 'HEAD', ['ln.txt']);
      expect(existsSync(path.join(repo, 'ln.txt'))).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('keep\n');
    });
  });
});

describe('GitClient sign-in with an Azure DevOps token', () => {
  const PAT = 'pat-never-shown-42';
  const B64 = Buffer.from(`:${PAT}`).toString('base64');
  let server: http.Server;
  let base: string;
  const seen: (string | undefined)[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  afterEach(() => {
    vi.unstubAllEnvs();
    seen.length = 0;
  });

  /** No helper from the machine's config may answer (or pop up) for the test server. */
  const isolate = () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'credential.helper');
    vi.stubEnv('GIT_CONFIG_VALUE_0', '');
    vi.stubEnv('GCM_INTERACTIVE', 'never');
  };

  const clientWithToken = () => {
    const calls: { cwd: string; remote: string; url: string }[] = [];
    const c = new GitClient(undefined, {
      auth: async (o) => {
        calls.push(o);
        return {
          env: extraHeaderEnv(`${base}/org/`, PAT),
          connectionId: 'c1',
        };
      },
    });
    return { c, calls };
  };

  /** `user` puts a user name in the URL, as Azure DevOps clone URLs have; the header's scope has none. */
  const repoWithServerOrigin = (user = '') => {
    const repo = makeRepo();
    const url = user ? base.replace('://', `://${user}@`) : base;
    git(repo, 'remote', 'add', 'origin', `${url}/org/p/_git/r`);
    return repo;
  };

  const expectNoToken = (e: unknown) => {
    const err = e as GitAuthError;
    for (const text of [err.message, err.stderr, String(err.cause)]) {
      expect(text).not.toContain(PAT);
      expect(text).not.toContain(B64);
    }
  };

  it('fetch sends the token as a header and reports a sign-in failure without it', async () => {
    isolate();
    const repo = repoWithServerOrigin();
    const { c, calls } = clientWithToken();
    const err = await c.fetch(repo, 'origin/main').catch((e: unknown) => e);
    expect(calls).toEqual([
      { cwd: repo, remote: 'origin', url: `${base}/org/p/_git/r` },
    ]);
    expect(seen).toContain(`Basic ${B64}`);
    expect(err).toBeInstanceOf(GitAuthError);
    expect((err as GitAuthError).hint).toEqual({
      host: '127.0.0.1',
      connectionId: 'c1',
      path: repo,
    });
    expect((err as Error).message).toMatch(
      /^git fetch --quiet origin main failed/,
    );
    expectNoToken(err);
  });

  it('push sends the token as a header and reports a sign-in failure without it', async () => {
    isolate();
    const repo = repoWithServerOrigin('org');
    git(repo, 'checkout', '-q', '-b', 'feature/a');
    const { c } = clientWithToken();
    const err = await c
      .push(repo, 'origin', 'feature/a')
      .catch((e: unknown) => e);
    expect(seen).toContain(`Basic ${B64}`);
    expect(err).toBeInstanceOf(GitAuthError);
    expect((err as Error).message).not.toMatch(/^git push/);
    expect((err as GitAuthError).hint.connectionId).toBe('c1');
    expectNoToken(err);
  });

  it('without a provider, a sign-in failure still says so and names no connection', async () => {
    isolate();
    const repo = repoWithServerOrigin();
    const err = await new GitClient()
      .fetch(repo, 'origin/main')
      .catch((e: unknown) => e);
    expect(seen.every((h) => h === undefined)).toBe(true);
    expect(err).toBeInstanceOf(GitAuthError);
    expect((err as GitAuthError).hint).toMatchObject({ connectionId: null });
  });

  it('a provider that throws runs git without a token', async () => {
    isolate();
    const repo = repoWithServerOrigin();
    const c = new GitClient(undefined, {
      auth: async () => {
        throw new Error('boom');
      },
    });
    const err = await c.fetch(repo, 'origin/main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitAuthError);
    expect(seen.every((h) => h === undefined)).toBe(true);
  });

  it('other failures stay GitErrors', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const { c } = clientWithToken();
    const err = await c.fetch(repo, 'origin/nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err).not.toBeInstanceOf(GitAuthError);
  });
});
