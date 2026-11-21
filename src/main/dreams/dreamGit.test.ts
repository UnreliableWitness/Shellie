import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../services/GitClient';
import { cleanupTempRepos, git, makeRepo } from '../test-helpers/gitRepo';
import {
  changedPaths,
  commitFiles,
  CHANGES_DIFF_CUT,
  CHANGES_DIFF_MAX,
  commitSubject,
  nextDreamId,
  removeDream,
  unattendedConfig,
  writeChangesDiff,
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
  it('runs every dream git call with long paths on, hooks to an empty folder, no fsmonitor, no signing', () => {
    expect(unattendedConfig('/h')).toEqual([
      'core.hooksPath=/h',
      'core.fsmonitor=false',
      'commit.gpgsign=false',
      'core.longpaths=true',
    ]);
  });

  it('lists changed, added and deleted paths, untracked folders file by file', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, 'gone.md'), 'x');
    git(repo, 'add', 'gone.md');
    git(repo, 'commit', '-q', '-m', 'gone');
    writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    rmSync(path.join(repo, 'gone.md'));
    mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(repo, 'a', 'b', 'new file é.md'), 'y');
    writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
    writeFileSync(path.join(repo, 'a.log'), 'z');
    expect(await changedPaths(gc, repo, [])).toEqual([
      '.gitignore',
      'README.md',
      'a.log',
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
      `dream: ${'x'.repeat(64)}…\nWhy.`,
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

  it('skips a number it is told is taken', async () => {
    const repo = makeRepo();
    const dir = path.join(path.dirname(repo), 'dreams');
    expect(
      await nextDreamId(gc, repo, dir, NOW, new Set(['2026-11-20-1'])),
    ).toBe('2026-11-20-2');
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
    await removeDream(
      gc,
      repo,
      { dir, worktree: wt, branch: 'dream/d1' },
      unattendedConfig(hooks),
    );
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, 'branch', '--list', 'dream/*').trim()).toBe('');
    expect(
      (await gc.worktreeList(repo)).map((w) => path.basename(w.path)),
    ).toEqual(['repo']);
  });

  it('keeps the whole subject within 72 characters, on one line, without splitting a surrogate pair', () => {
    expect(commitSubject('Short')).toBe('dream: Short');
    const long = commitSubject('y'.repeat(100));
    expect(long).toHaveLength(72);
    expect(long.endsWith('y…')).toBe(true);
    expect(commitSubject('a\r\nb\tc\u0000\u0007d')).toBe('dream: a b c d');
    // 63 y's, then an emoji whose surrogate pair would straddle the cut at 71.
    const emoji = commitSubject(`${'y'.repeat(63)}\u{1F600}${'z'.repeat(20)}`);
    expect(emoji).toBe(`dream: ${'y'.repeat(63)}…`);
    expect(emoji.length).toBeLessThanOrEqual(72);
  });

  it('writes the worktree against the base as git’s diff, a new untracked file included, index untouched', async () => {
    const repo = makeRepo();
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(path.join(repo, 'README.md'), 'changed line\n');
    mkdirSync(path.join(repo, '.apm', 'rules'), { recursive: true });
    writeFileSync(
      path.join(repo, '.apm', 'rules', 'logging.md'),
      'Write every log message in English.\n',
    );
    const out = path.join(path.dirname(repo), 'data', 'changes.diff');
    mkdirSync(path.dirname(out));
    const statusBefore = git(repo, 'status', '--porcelain');
    const hooks = path.join(path.dirname(repo), 'nohooks');
    mkdirSync(hooks);
    await writeChangesDiff(gc, repo, {
      base,
      file: out,
      index: path.join(path.dirname(repo), 'changes.index'),
      config: unattendedConfig(hooks),
      paths: ['.apm/rules/logging.md', 'README.md'],
    });
    const diff = readFileSync(out, 'utf8');
    expect(diff).toContain('+++ b/.apm/rules/logging.md');
    expect(diff).toContain('+Write every log message in English.');
    expect(diff).toContain('+++ b/README.md');
    expect(diff).toContain('+changed line');
    expect(diff).not.toContain(CHANGES_DIFF_CUT);
    // The worktree's own index and status stay as they were; the temporary index is gone.
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(existsSync(path.join(path.dirname(repo), 'changes.index'))).toBe(
      false,
    );
  });

  it('cuts the diff at 2 MB and ends it with a line saying so', async () => {
    const repo = makeRepo();
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const line = `${'x'.repeat(99)}\n`;
    writeFileSync(path.join(repo, 'big.md'), line.repeat(30_000));
    const out = path.join(path.dirname(repo), 'changes.diff');
    await writeChangesDiff(gc, repo, {
      base,
      file: out,
      index: path.join(path.dirname(repo), 'changes.index'),
      config: [],
      paths: ['big.md'],
    });
    expect(CHANGES_DIFF_MAX).toBe(2 * 1024 * 1024);
    expect(statSync(out).size).toBeLessThanOrEqual(CHANGES_DIFF_MAX);
    const diff = readFileSync(out, 'utf8');
    expect(diff.endsWith(`\n${CHANGES_DIFF_CUT}\n`)).toBe(true);
    // Cut at a line end: every line before the note is a whole diff line.
    const lines = diff.split('\n').slice(0, -2);
    expect(lines.filter((l) => l.startsWith('+x')).at(-1)).toBe(
      `+${'x'.repeat(99)}`,
    );
  });
  it('adds only the changed paths, literally and ignored ones too, with a 120 s timeout, and leaves no index or lock', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, '.gitignore'), '*.log\n');
    writeFileSync(path.join(repo, 'gone.md'), 'gone\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'ignore logs');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    mkdirSync(path.join(repo, '.apm'));
    // Ignored, but written by the propose run inside an allowed folder: the check run must see it.
    writeFileSync(path.join(repo, '.apm', 'notes.log'), 'an ignored write\n');
    writeFileSync(path.join(repo, '.apm', '*.md'), 'a literal star\n');
    writeFileSync(path.join(repo, '.apm', 'x.md'), 'not changed by name\n');
    rmSync(path.join(repo, 'gone.md'));
    writeFileSync(path.join(repo, 'elsewhere.md'), 'not in the list\n');
    const index = path.join(path.dirname(repo), 'changes.index');
    // A lock a killed git left: removed afterwards too.
    const real: GitClient['run'] = (cwd, args, o) =>
      GitClient.prototype.run.call(gc, cwd, args, o);
    const spy = vi.spyOn(gc, 'run');
    spy.mockImplementation(async (cwd, args, o) => {
      if (args.includes('add')) writeFileSync(`${index}.lock`, '');
      return real(cwd, args, o);
    });
    const out = path.join(path.dirname(repo), 'changes.diff');
    await expect(
      writeChangesDiff(gc, repo, {
        base,
        file: out,
        index,
        config: [],
        paths: ['.apm/*.md', '.apm/notes.log', 'gone.md'],
      }),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(existsSync(`${index}.lock`)).toBe(false);
    expect(existsSync(index)).toBe(false);
    const calls = vi.fn();
    const watched = vi
      .spyOn(gc, 'run')
      .mockImplementation(async (cwd, args, o) => {
        calls(args, o);
        return real(cwd, args, o);
      });
    await writeChangesDiff(gc, repo, {
      base,
      file: out,
      index,
      config: [],
      paths: ['.apm/*.md', '.apm/notes.log', 'gone.md'],
    });
    watched.mockRestore();
    const diff = readFileSync(out, 'utf8');
    expect(diff).toContain('+++ b/.apm/notes.log');
    expect(diff).toContain('+++ b/.apm/*.md');
    expect(diff).toContain('--- a/gone.md');
    expect(diff).not.toContain('x.md');
    expect(diff).not.toContain('elsewhere.md');
    for (const [args, o] of calls.mock.calls as [
      string[],
      { timeoutMs?: number },
    ][]) {
      expect(o?.timeoutMs).toBe(120_000);
      expect(args).not.toContain('-A');
    }
    const add = (calls.mock.calls as [string[]][]).find(([a]) =>
      a.includes('add'),
    )![0];
    expect(add).toEqual(expect.arrayContaining(['--literal-pathspecs', '-f']));
  });
});
