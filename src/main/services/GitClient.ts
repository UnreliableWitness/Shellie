import { execFile, type ExecFileOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitSummary, TaskSummary } from '../../shared/types';
import {
  pathExists,
  realWait,
  removeTree,
  withRetry,
  type Wait,
} from '../fsRetry';
import { isInside, nativePath, samePath, worktreeRoot } from '../paths';
import {
  isGitAuthFailure,
  remoteHost,
  type GitAuthHint,
} from '../../shared/gitAuth';
import { errorMessage } from '../../shared/errors';
import type { GitAuth, GitAuthEnv } from './gitAuth';

const execFileAsync = promisify(execFile);

/** Long enough for an interactive Git Credential Manager sign-in, short enough that Finish never hangs. */
const PUSH_TIMEOUT_MS = 120_000;

/** Generous for a large checkout and its hooks (git-lfs on a slow disk), but a hung `worktree add` still fails (#148). */
const WORKTREE_TIMEOUT_MS = 300_000;

/** Fails ssh instead of waiting on a passphrase or host-key question no one can see. Agent keys still work. */
const BATCH_SSH = 'ssh -o BatchMode=yes';

class GitTimeoutError extends Error {}

class WorktreeStepTimeout extends Error {}

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly stderr: string,
    public readonly code: number | null,
    cause?: unknown,
  ) {
    super(
      `git ${args.join(' ')} failed${code === null ? '' : ` (${code})`}: ${stderr.trim()}`,
      { cause },
    );
    this.name = 'GitError';
  }
}

const NO_AUTH: GitAuthEnv = { env: {}, connectionId: null };

/** A fetch or push that could not sign in to its remote. The message is git's own, without the token. */
export class GitAuthError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly hint: GitAuthHint,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'GitAuthError';
  }
}

/** How Windows reports a folder that a process (a shell, a dev server, an indexer) still holds open. */
export const FOLDER_IN_USE =
  /Permission denied|Directory not empty|being used by another process|EBUSY/i;

/**
 * Backoff for removing a worktree, about 5 s in total: with conpty.dll a killed terminal's pipe closes
 * before a child that handles CTRL_CLOSE (a dev server) has let go of the folder.
 */
const REMOVE_WAITS = [50, 100, 200, 400, 800, 1600, 1850];

/** A Done page lists at most this many commits; `commitCount` has the full number. */
const MAX_SUMMARY_COMMITS = 50;
/** Generated files a PR description gains nothing from. */
const LOCK_FILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'packages.lock.json',
  'Cargo.lock',
  'poetry.lock',
];

/** `origin/main` -> origin and main when `origin` is one of `remotes`; null for anything else. */
export function splitRemoteRef(
  ref: string,
  remotes: string[],
): { remote: string; branch: string } | null {
  const slash = ref.indexOf('/');
  if (slash <= 0 || !remotes.includes(ref.slice(0, slash))) return null;
  return { remote: ref.slice(0, slash), branch: ref.slice(slash + 1) };
}

/** Thin wrapper over the git CLI. Every method takes the directory to run in. */
export class GitClient {
  readonly pushTimeoutMs: number;
  readonly worktreeTimeoutMs: number;
  private readonly auth: GitAuth | undefined;

  constructor(
    private readonly wait: Wait = realWait,
    opts: {
      pushTimeoutMs?: number;
      worktreeTimeoutMs?: number;
      auth?: GitAuth;
    } = {},
  ) {
    this.pushTimeoutMs = opts.pushTimeoutMs ?? PUSH_TIMEOUT_MS;
    this.worktreeTimeoutMs = opts.worktreeTimeoutMs ?? WORKTREE_TIMEOUT_MS;
    this.auth = opts.auth;
  }

  /** The environment a network command against `remote` runs with (an Azure Repos token), and where it goes. */
  private async remoteAuth(
    cwd: string,
    remote: string,
  ): Promise<{ auth: GitAuthEnv; host: string | null }> {
    const url = await this.remoteUrl(cwd, remote);
    if (!url) return { auth: NO_AUTH, host: null };
    const host = remoteHost(url);
    if (!this.auth) return { auth: NO_AUTH, host };
    try {
      return { auth: await this.auth({ cwd, remote, url }), host };
    } catch {
      return { auth: NO_AUTH, host };
    }
  }

  /** A GitError that says git could not sign in becomes a GitAuthError with the same message; others pass. */
  private signInError(
    e: unknown,
    cwd: string,
    remote: string,
    ctx: { auth: GitAuthEnv; host: string | null },
    message: (e: GitError) => string,
  ): unknown {
    if (!(e instanceof GitError) || !isGitAuthFailure(e.stderr)) return e;
    return new GitAuthError(
      message(e),
      e.stderr,
      {
        host: ctx.host ?? remote,
        connectionId: ctx.auth.connectionId,
        path: cwd,
      },
      e,
    );
  }

  async run(
    cwd: string,
    args: string[],
    opts: { timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<string> {
    try {
      const options = {
        cwd,
        env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      };
      if (opts.timeoutMs === undefined)
        return (await execFileAsync('git', args, options)).stdout;
      return await execWithTimeout(args, options, opts.timeoutMs);
    } catch (e) {
      if (e instanceof GitTimeoutError) throw e;
      const err = e as {
        stderr?: string;
        code?: number | string;
        message: string;
      };
      const code = typeof err.code === 'number' ? err.code : null;
      const stderr = (err.stderr ?? '').trim() || err.message;
      throw new GitError(args, stderr, code, e);
    }
  }

  async toplevel(dir: string): Promise<string | null> {
    try {
      const out = (
        await this.run(dir, ['rev-parse', '--show-toplevel'])
      ).trim();
      return out ? nativePath(out) : null;
    } catch {
      return null;
    }
  }

  /** The shared .git directory, also from inside a linked worktree. */
  async commonDir(cwd: string): Promise<string> {
    const out = (await this.run(cwd, ['rev-parse', '--git-common-dir'])).trim();
    return nativePath(path.resolve(cwd, out));
  }

  async branchExists(cwd: string, branch: string): Promise<boolean> {
    try {
      await this.run(cwd, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether a ref (e.g. refs/remotes/origin/x) or commit sha resolves to a commit. */
  async commitExists(cwd: string, ref: string): Promise<boolean> {
    try {
      await this.run(cwd, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${ref}^{commit}`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Commits on `branch` since `base`, and the ones of those no remote has, which deleting the branch loses
   * (#124). A missing branch has none; with no base every commit no remote has counts for both.
   */
  async branchCommits(
    cwd: string,
    branch: string,
    base: string | null,
  ): Promise<{ commits: number; unpushed: number }> {
    if (!(await this.branchExists(cwd, branch)))
      return { commits: 0, unpushed: 0 };
    const ref = `refs/heads/${branch}`;
    const count = async (args: string[]) =>
      Number((await this.run(cwd, ['rev-list', '--count', ...args])).trim()) ||
      0;
    const unpushed = await count([
      ref,
      '--not',
      '--remotes',
      ...(base ? [base] : []),
    ]);
    const commits = base ? await count([`${base}..${ref}`]) : unpushed;
    return { commits, unpushed };
  }

  async validBranchName(cwd: string, branch: string): Promise<boolean> {
    if (branch.length === 0 || branch.startsWith('-')) return false;
    try {
      await this.run(cwd, ['check-ref-format', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  async remotes(cwd: string): Promise<string[]> {
    return (await this.run(cwd, ['remote']))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** `origin/main` fetches `main` from `origin`. A ref without a known remote prefix is left alone. Returns whether it fetched. */
  async fetch(cwd: string, baseRef: string): Promise<boolean> {
    if (baseRef.indexOf('/') <= 0) return false;
    const split = splitRemoteRef(baseRef, await this.remotes(cwd));
    if (!split) return false;
    const ctx = await this.remoteAuth(cwd, split.remote);
    try {
      await this.run(cwd, ['fetch', '--quiet', split.remote, split.branch], {
        env: ctx.auth.env,
      });
    } catch (e) {
      if (e instanceof GitError && /couldn't find remote ref/i.test(e.stderr)) {
        const fallback = await this.defaultBaseRef(cwd);
        const real = fallback.startsWith(`${split.remote}/`)
          ? fallback.slice(split.remote.length + 1)
          : null;
        const friendly = new GitError(e.args, e.stderr, e.code, e);
        friendly.message =
          `${split.remote} has no branch '${split.branch}'.` +
          (real && real !== split.branch
            ? ` This repo's default branch is '${real}'; set \`base: ${real}\` in .shellie.yml.`
            : ' Set `base:` in .shellie.yml to a branch that exists there.');
        throw friendly;
      }
      throw this.signInError(e, cwd, split.remote, ctx, (g) => g.message);
    }
    return true;
  }

  /** `git worktree list --porcelain`: every worktree (the main checkout first) with its branch, null when detached. */
  async worktreeList(
    cwd: string,
  ): Promise<{ path: string; branch: string | null }[]> {
    const out = await this.run(cwd, ['worktree', 'list', '--porcelain']);
    const list: { path: string; branch: string | null }[] = [];
    for (const block of out.split(/\r?\n\r?\n/)) {
      let wt: string | null = null;
      let branch: string | null = null;
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) wt = line.slice('worktree '.length);
        else if (line.startsWith('branch '))
          branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      }
      if (wt) list.push({ path: nativePath(wt), branch });
    }
    return list;
  }

  async mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
    try {
      return (await this.run(cwd, ['merge-base', a, b])).trim() || null;
    } catch {
      return null;
    }
  }

  /** The ref a task branches from: origin's HEAD branch, else origin/main or origin/master, else local main or master, else HEAD. */
  async defaultBaseRef(cwd: string): Promise<string> {
    try {
      const head = (
        await this.run(cwd, [
          'symbolic-ref',
          '--short',
          'refs/remotes/origin/HEAD',
        ])
      ).trim();
      if (head && (await this.commitExists(cwd, `refs/remotes/${head}`)))
        return head;
    } catch {
      // no origin/HEAD
    }
    for (const ref of ['origin/main', 'origin/master'])
      if (await this.commitExists(cwd, `refs/remotes/${ref}`)) return ref;
    for (const b of ['main', 'master'])
      if (await this.branchExists(cwd, b)) return b;
    return 'HEAD';
  }

  /** The checked-out branch, or null when detached. */
  async currentBranch(cwd: string): Promise<string | null> {
    try {
      return (await this.run(cwd, ['branch', '--show-current'])).trim() || null;
    } catch {
      return null;
    }
  }

  /** Runs a worktree step with `worktreeTimeoutMs`; a hang fails with `<step> timed out after <s> s`. */
  private async runWorktreeStep(
    cwd: string,
    args: string[],
    step: string,
  ): Promise<string> {
    try {
      return await this.run(cwd, args, { timeoutMs: this.worktreeTimeoutMs });
    } catch (e) {
      if (e instanceof GitTimeoutError)
        throw new WorktreeStepTimeout(
          `${step} timed out after ${this.worktreeTimeoutMs / 1000} s`,
        );
      throw e;
    }
  }

  async worktreeAdd(
    cwd: string,
    o: { branch: string; path: string; baseRef: string },
  ): Promise<string> {
    try {
      await this.runWorktreeStep(
        cwd,
        [
          '-c',
          'core.longpaths=true',
          'worktree',
          'add',
          // Without this, a branch made from origin/main tracks origin/main and looks "not pushed" forever.
          '--no-track',
          '-b',
          o.branch,
          o.path,
          o.baseRef,
        ],
        'git worktree add',
      );
    } catch (e) {
      if (e instanceof WorktreeStepTimeout)
        await this.discardPartial(cwd, o, true);
      throw e;
    }
    return (
      await this.runWorktreeStep(o.path, ['rev-parse', 'HEAD'], 'git rev-parse')
    ).trim();
  }

  /** A worktree for a branch that already exists (reopening a finished task). */
  async worktreeAddExisting(
    cwd: string,
    o: { branch: string; path: string },
  ): Promise<void> {
    try {
      await this.runWorktreeStep(
        cwd,
        ['-c', 'core.longpaths=true', 'worktree', 'add', o.path, o.branch],
        'git worktree add',
      );
    } catch (e) {
      if (e instanceof WorktreeStepTimeout)
        await this.discardPartial(cwd, o, false);
      throw e;
    }
  }

  /**
   * A killed `git worktree add` leaves its folder and (for `-b`) its new branch behind, and a retry would
   * reuse that half-made checkout. Best effort: the timeout error is what the caller needs to see.
   */
  private async discardPartial(
    cwd: string,
    o: { branch: string; path: string },
    createdBranch: boolean,
  ): Promise<void> {
    await this.worktreeRemove(cwd, o.path, true).catch(() => undefined);
    await removeTree(o.path, this.wait).catch(() => undefined);
    await this.worktreePrune(cwd).catch(() => undefined);
    if (createdBranch)
      await this.deleteBranch(cwd, o.branch).catch(() => undefined);
  }

  async worktreeRemove(
    cwd: string,
    worktreePath: string,
    force: boolean,
  ): Promise<void> {
    // Just-killed terminals can hold the folder for a moment on Windows; retry those failures only.
    try {
      await withRetry(
        () =>
          this.run(cwd, [
            '-c',
            'core.longpaths=true',
            'worktree',
            'remove',
            ...(force ? ['--force'] : []),
            worktreePath,
          ]),
        (e) => e instanceof GitError && FOLDER_IN_USE.test(e.stderr),
        this.wait,
        REMOVE_WAITS,
      );
    } catch (e) {
      if (!force || !(await this.isOwnLeftover(cwd, worktreePath))) throw e;
      // Git stops at a name Windows will not delete (a `nul` file left by a shell's `2>nul`, #87) after it
      // has removed the folder's .git file and its registration, so every later try fails too. Delete
      // what is left here and drop any registration.
      try {
        await removeTree(worktreePath, this.wait);
      } catch (rm) {
        // The fs code (EPERM, EBUSY) stays on the error: Finish tells a held file from other failures by it.
        throw Object.assign(
          new Error(
            `Could not delete ${worktreePath}: ${errorMessage(rm)}. Close what has files open there and try again.`,
            { cause: e },
          ),
          { code: (rm as NodeJS.ErrnoException).code },
        );
      }
      await this.worktreePrune(cwd);
    }
  }

  /**
   * `p` may be deleted by hand: one of the repo's linked worktrees (never its main checkout), or what a
   * failed removal left in the repo's `<repo>.worktrees` folder, no longer a working tree of anything.
   */
  private async isOwnLeftover(cwd: string, p: string): Promise<boolean> {
    const list = await this.worktreeList(cwd).catch(() => null);
    if (!list) return false;
    // Never one that holds another checkout of the repo (the first entry is the main checkout).
    if (list.some((w) => !samePath(w.path, p) && isInside(p, w.path)))
      return false;
    if (list.slice(1).some((w) => samePath(w.path, p))) return true;
    const root = worktreeRoot(list[0].path);
    return (
      isInside(root, p) &&
      !samePath(root, p) &&
      !(await pathExists(path.join(p, '.git')))
    );
  }

  async worktreePrune(cwd: string): Promise<void> {
    await this.run(cwd, ['-c', 'core.longpaths=true', 'worktree', 'prune']);
  }

  async deleteBranch(cwd: string, branch: string): Promise<void> {
    await this.run(cwd, ['branch', '-D', branch]);
  }

  /** The URL of a remote, or null when there is no such remote. */
  async remoteUrl(cwd: string, remote: string): Promise<string | null> {
    try {
      return (
        (await this.run(cwd, ['remote', 'get-url', remote])).trim() || null
      );
    } catch {
      return null;
    }
  }

  /**
   * Pushes a branch and sets its upstream. Never forces; a failure throws git's own stderr. Runs without a
   * console, so ssh runs in batch mode (unless the user set their own ssh command) and the push gives up
   * after `pushTimeoutMs`. Git Credential Manager stays on: users sign in through it.
   */
  async push(cwd: string, remote: string, branch: string): Promise<void> {
    const ctx = await this.remoteAuth(cwd, remote);
    const env: Record<string, string> = {
      ...((await this.hasOwnSshCommand(cwd))
        ? {}
        : { GIT_SSH_COMMAND: BATCH_SSH }),
      ...ctx.auth.env,
    };
    try {
      await this.run(cwd, ['push', '-u', remote, branch], {
        timeoutMs: this.pushTimeoutMs,
        env,
      });
    } catch (e) {
      if (e instanceof GitTimeoutError)
        throw new Error(
          `git push timed out after ${this.pushTimeoutMs / 1000} s (a credential prompt may be waiting)`,
        );
      const signIn = this.signInError(e, cwd, remote, ctx, (g) =>
        g.stderr.trim(),
      );
      if (signIn instanceof GitAuthError) throw signIn;
      throw e instanceof GitError ? new Error(e.stderr.trim()) : e;
    }
  }

  private async hasOwnSshCommand(cwd: string): Promise<boolean> {
    if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return true;
    const configured = await this.run(cwd, [
      'config',
      '--get',
      'core.sshCommand',
    ]).catch(() => '');
    return configured.trim() !== '';
  }

  async summary(worktree: string, baseRef: string): Promise<GitSummary> {
    const out = await this.run(worktree, [
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '--branch',
    ]);
    const lines = out.split('\n');
    const head = lines.shift() ?? '';
    const m = /^## (\S+?)(?:\.\.\.(\S+))?(?: \[([^\]]+)\])?$/.exec(head);
    let branch = m?.[1] ?? '';
    if (!m || branch === 'HEAD') {
      const current = (
        await this.run(worktree, ['branch', '--show-current'])
      ).trim();
      branch = current || 'HEAD';
    }
    const upstream = m?.[2];
    const track = m?.[3] ?? '';
    const num = (re: RegExp) => Number(re.exec(track)?.[1] ?? 0);
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      ahead = num(/ahead (\d+)/);
      behind = num(/behind (\d+)/);
    } else {
      try {
        ahead =
          Number(
            (
              await this.run(worktree, [
                'rev-list',
                '--count',
                `${baseRef}..HEAD`,
              ])
            ).trim(),
          ) || 0;
      } catch {
        ahead = 0;
      }
    }
    const files = lines
      .filter((l) => l.length > 3)
      .map((l) => ({
        status: (l.slice(0, 2).trim()[0] ?? '?') as string,
        path: l.slice(3),
      }));
    return { branch, ahead, behind, hasUpstream: Boolean(upstream), files };
  }

  /**
   * Where the task's branch left its base: the recorded `baseSha` when it is still a commit, else the merge
   * base with `baseRef` (tasks from before Shellie recorded it), else null.
   */
  async resolveBase(
    worktree: string,
    o: { baseRef: string; baseSha: string | null },
  ): Promise<string | null> {
    if (o.baseSha) {
      try {
        const sha = (
          await this.run(worktree, [
            'rev-parse',
            '--verify',
            '--quiet',
            `${o.baseSha}^{commit}`,
          ])
        ).trim();
        if (sha) return sha;
      } catch {
        /* fall through to the merge base */
      }
    }
    return this.mergeBase(worktree, o.baseRef, 'HEAD');
  }

  /**
   * What the branch did since its base, as text for a PR description (#111): its log with commit bodies (the newest
   * 50), the diff stat and the diff, without lock files. Null when the base cannot be found.
   */
  async branchChanges(
    worktree: string,
    o: { baseRef: string; baseSha: string | null },
  ): Promise<{ log: string; stat: string; diff: string } | null> {
    const base = await this.resolveBase(worktree, o).catch(() => null);
    if (!base) return null;
    const range = `${base}..HEAD`;
    const [log, stat, diff] = await Promise.all([
      this.run(worktree, [
        'log',
        `--max-count=${MAX_SUMMARY_COMMITS}`,
        '--format=- %h %s%n%w(0,2,2)%b',
        range,
      ]),
      this.run(worktree, ['diff', '--no-color', '--stat=120', range]),
      this.run(worktree, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '-U2',
        range,
        '--',
        '.',
        ...LOCK_FILES.map((f) => `:(exclude,glob)**/${f}`),
      ]),
    ]);
    return { log: log.replace(/\n{2,}/g, '\n').trim(), stat, diff };
  }

  /**
   * Puts each worktree-relative path back as it is at `ref`, in the index and the working tree; a path
   * `ref` does not have is removed from both (an untracked file is just deleted). Paths are taken
   * literally and must stay inside the worktree, also after following symlinked folders; a symlink
   * itself is removed, never what it points to.
   */
  async discardPaths(
    worktree: string,
    ref: string,
    paths: string[],
  ): Promise<void> {
    const root = await fs.realpath(worktree);
    const targets = await Promise.all(
      paths.map(async (rel) => ({ rel, abs: await containedPath(root, rel) })),
    );
    for (const { rel, abs } of targets) {
      const inRef = await this.run(worktree, [
        'cat-file',
        '-e',
        `${ref}:${rel}`,
      ])
        .then(() => true)
        .catch(() => false);
      if (inRef) {
        await this.run(worktree, [
          '--literal-pathspecs',
          'restore',
          `--source=${ref}`,
          '--staged',
          '--worktree',
          '--',
          rel,
        ]);
        continue;
      }
      const st = await fs.lstat(abs).catch(() => null);
      if (st?.isDirectory()) throw new Error(`${rel} is a folder`);
      await this.run(worktree, [
        '--literal-pathspecs',
        'rm',
        '-f',
        '-q',
        '--ignore-unmatch',
        '--',
        rel,
      ]);
      await fs.rm(abs, { force: true });
    }
  }

  /** The worktree's own git dir (`.git/worktrees/<name>` for a linked worktree), absolute. */
  async gitDir(worktree: string): Promise<string> {
    const out = await this.run(worktree, ['rev-parse', '--absolute-git-dir']);
    return nativePath(out.trim());
  }

  /**
   * What the task's branch did since it left its base: its commits (the newest 50, oldest first), the diff
   * stat, and whether it is pushed. The range starts at the recorded `baseSha`, else at the merge base with
   * `baseRef` (tasks from before Shellie recorded it). With neither, commits and changes are left unknown.
   */
  async finishSummary(
    worktree: string,
    o: { baseRef: string; baseSha: string | null; branch: string },
  ): Promise<TaskSummary> {
    const { baseRef, branch } = o;
    const [range, { upstream, pushed }] = await Promise.all([
      this.resolveBase(worktree, o).then((base) => base && `${base}..HEAD`),
      this.pushState(worktree, baseRef, branch),
    ]);
    let commits: TaskSummary['commits'] = [];
    let commitCount = 0;
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    if (range) {
      const [count, log, stat] = await Promise.all([
        this.run(worktree, ['rev-list', '--count', range]),
        this.run(worktree, [
          'log',
          `--max-count=${MAX_SUMMARY_COMMITS}`,
          '--format=%h%x09%s',
          range,
        ]),
        this.run(worktree, ['diff', '--shortstat', range]),
      ]);
      commitCount = Number(count.trim()) || 0;
      commits = log
        .split('\n')
        .filter(Boolean)
        .reverse()
        .map((l) => {
          const tab = l.indexOf('\t');
          return tab < 0
            ? { sha: l, subject: '' }
            : { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
        });
      const num = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
      filesChanged = num(/(\d+) files? changed/);
      insertions = num(/(\d+) insertions?\(\+\)/);
      deletions = num(/(\d+) deletions?\(-\)/);
    }
    return {
      commits,
      commitCount,
      filesChanged,
      insertions,
      deletions,
      pushed,
      upstream,
      baseKnown: range !== null,
    };
  }

  /**
   * Whether `branch` is on its remote: `<remote>/<branch>` exists and contains HEAD. The remote is the base's
   * remote, else `origin`. The configured upstream is ignored, since `git push origin <branch>` does not set it.
   */
  private async pushState(
    worktree: string,
    baseRef: string,
    branch: string,
  ): Promise<{ upstream: string | null; pushed: boolean }> {
    let remotes: string[];
    try {
      remotes = await this.remotes(worktree);
    } catch {
      return { upstream: null, pushed: false };
    }
    const remote =
      splitRemoteRef(baseRef, remotes)?.remote ??
      (remotes.includes('origin') ? 'origin' : null);
    if (
      !remote ||
      !(await this.commitExists(worktree, `refs/remotes/${remote}/${branch}`))
    )
      return { upstream: null, pushed: false };
    const upstream = `${remote}/${branch}`;
    try {
      await this.run(worktree, [
        'merge-base',
        '--is-ancestor',
        'HEAD',
        `refs/remotes/${upstream}`,
      ]);
      return { upstream, pushed: true };
    } catch {
      return { upstream, pushed: false };
    }
  }
}

/**
 * `rel` joined to the worktree's real path, refused when it leaves the worktree: absolute, `..`, the
 * `.git` folder, or a parent folder that is a symlink to somewhere outside.
 */
async function containedPath(root: string, rel: string): Promise<string> {
  const parts = rel.split(/[\\/]/);
  if (
    !rel ||
    rel.includes('\0') ||
    path.isAbsolute(rel) ||
    path.win32.isAbsolute(rel) ||
    parts.includes('..') ||
    parts[0] === '.git'
  )
    throw new Error('Outside the worktree');
  const abs = path.join(root, rel);
  // The nearest folder that exists decides: a deleted file's folder may be gone too.
  for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
    let real: string;
    try {
      real = await fs.realpath(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && dir !== root)
        continue;
      throw e;
    }
    if (!isInside(root, real)) throw new Error('Outside the worktree');
    return abs;
  }
}

/**
 * execFile with a deadline. On timeout it kills git and stops reading its pipes at once: a helper git
 * started (a credential prompt, ssh, a hook) can keep the pipes open long after git itself is gone.
 */
function execWithTimeout(
  args: string[],
  options: ExecFileOptions,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile(
      'git',
      args,
      { ...options, windowsHide: true },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (err) reject(Object.assign(err, { stderr: String(stderr) }));
        else resolve(String(stdout));
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      const fail = () =>
        reject(new GitTimeoutError(`git ${args[0]} timed out`));
      killTree(child.pid, () => child.kill(), fail);
    }, timeoutMs);
  });
}

/**
 * Kills a process and everything it started. On Windows, killing git.exe leaves its helpers (a credential
 * prompt, ssh, a hook's shell) running, and they keep the worktree locked, so taskkill /T takes the whole
 * tree; `done` runs once it has finished. Elsewhere `kill` is enough: open folders do not block removal.
 */
export function killTree(
  pid: number | undefined,
  kill: () => void,
  done: () => void,
): void {
  if (process.platform !== 'win32' || pid === undefined) {
    kill();
    done();
    return;
  }
  execFile(
    'taskkill',
    ['/pid', String(pid), '/T', '/F'],
    { windowsHide: true },
    () => {
      kill();
      done();
    },
  );
}
