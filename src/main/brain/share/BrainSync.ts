/**
 * Keeps a shared brain's folder in step with its server repo (the shared-brains spec, "Sync"): pull before jobs and
 * every 15 minutes, push after every brain commit, hold a push that would send a secret, and queue again the jobs
 * whose output lost a clash with a colleague's change. Only fetches, merges and adds commits; the one exception is
 * `squashUnsent`, which folds commits that never left the machine into one after a scrub.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Brain, BrainJob, BrainSharing } from '../../../shared/brain';
import { isKeeper } from '../../../shared/brainShare';
import { GitAuthError, type GitClient } from '../../services/GitClient';
import type { BrainStore } from '../BrainStore';
import { withBrainGit } from '../gitMutex';
import type { BrainJobRunner } from '../jobs';
import { TICK_MS } from '../scheduler';
import { findSecrets } from '../secrets';
import { absPath } from '../paths';
import { READS_RECORD } from '../reads';
import { acquireLock, readState, releaseLock, writeState } from '../state';
import { readOrigin } from './files';
import { mergeServer, type JobRef } from './merge';

export const RAN_AGAIN =
  'Ran again: a colleague changed the brain at the same time';
/** A job runs again at most this many times after a clash; the next clash fails it (two runs that both clashed). */
const MAX_REPLAYS = 1;
const PUSH_DELAY_MS = 2000;
/** A colleague's source still uncaptured this long after it arrived is captured by the keeper. */
const UNCAPTURED_MS = 3600_000;
const SERVER = 'origin/main';
/** A fetch no one watches gives up after this long (a hung network or a sign-in prompt). */
const FETCH_TIMEOUT_MS = 120_000;
export const SQUASH_MESSAGE = 'Brain: changes since the last send';
const RECORDS_MESSAGE =
  'Brain: records moved to the changes since the last send';
/** git's empty tree: what a brain is compared with before the server has a main. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const PENDING: ReadonlySet<BrainJob['status']> = new Set([
  'queued',
  'running',
  'paused',
]);

export type SyncRunner = Pick<
  BrainJobRunner,
  'enqueue' | 'jobs' | 'running' | 'fail'
>;

export type BrainSyncDeps = {
  brains: BrainStore;
  git: GitClient;
  runner: () => SyncRunner;
  /** Tells the windows the brain changed (`brain:changed`). */
  changed: (brainId: string) => void;
  /** Commits edits made outside a job (`commitJobOutput` with OUTSIDE_EDIT_MESSAGE), so a merge runs on a clean tree. */
  commitOutsideEdits: (brainId: string) => Promise<void>;
  /** This install's id: the keeper picks up colleagues' sources left uncaptured. Absent: never the keeper. */
  installId?: string;
  now?: () => Date;
  pushDelayMs?: number;
  tickMs?: number;
  fetchTimeoutMs?: number;
};

const sameJob = (j: BrainJob, r: JobRef) =>
  j.kind === r.kind &&
  j.source === r.source &&
  (r.kind === 'write'
    ? (j.target ?? null) === r.target
    : r.kind === 'settle'
      ? (j.conflict ?? null) === r.target
      : true);

const rejected = (e: unknown) =>
  /\[rejected\]|non-fast-forward|fetch first/i.test((e as Error).message);

/** A fetch or push that failed: the server, the network or the sign-in, not the brain folder. */
class ServerError extends Error {
  constructor(readonly error: unknown) {
    super((error as Error).message);
  }
}

/** Runs a fetch or push; its failure becomes a ServerError, a sign-in one stays a GitAuthError. */
const server = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e: unknown) => {
    throw e instanceof GitAuthError ? e : new ServerError(e);
  });
/** A path as git prints it in a diff header: C-quoted (`"b/a\"b.md"`) when it holds a quote, a backslash or a control character. */
/** A path as git prints it in a diff header: C-quoted (`"b/a\\"b.md"`) when it holds a quote, a backslash or a control character. */
export function unquoteGitPath(name: string): string {
  if (!name.startsWith('"') || name.length < 2) return name;
  const chars = Array.from(name.slice(1, name.lastIndexOf('"')));
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    '\\': 92,
  };
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c !== '\\' || i + 1 >= chars.length) {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = chars[++i];
    const octal = chars.slice(i, i + 3).join('');
    if (Object.hasOwn(escapes, n)) bytes.push(escapes[n]);
    else if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else bytes.push(...Buffer.from(n, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The status a failed sync leaves: a sign-in the server refused, a push it still refuses, or no server at all. */
function failureStatus(e: unknown): BrainSharing['status'] | null {
  if (e instanceof GitAuthError) return 'unauthorized';
  if (!(e instanceof ServerError)) return null;
  return rejected(e) ? 'pending' : 'unreachable';
}

export class BrainSync {
  private readonly now: () => Date;
  /** One pull or push at a time per brain. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pushTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(private readonly d: BrainSyncDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** The brain when it is shared and live. */
  private shared(id: string): Brain | null {
    const b = this.d.brains.get(id);
    return b?.sharing && !b.archived ? b : null;
  }

  private serial(id: string, fn: () => Promise<void>): Promise<void> {
    const run = (this.chains.get(id) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    this.chains.set(id, tail);
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id);
    });
    return run;
  }

  private async patch(id: string, change: Partial<BrainSharing>) {
    const sharing = this.d.brains.get(id)?.sharing;
    if (!sharing) return;
    const keys = Object.keys(change) as (keyof BrainSharing)[];
    if (keys.every((k) => sharing[k] === change[k])) return;
    await this.d.brains.patch(id, { sharing: { ...sharing, ...change } });
    this.d.changed(id);
  }

  private async fail(id: string, e: unknown) {
    console.error('[brain] sync failed', (e as Error).message);
    // A merge that could not run leaves the status: it says how the server is, and the next pull tries again.
    const status = failureStatus(e);
    if (status) await this.patch(id, { status }).catch(() => undefined);
  }

  /**
   * Fetches and merges the server's changes, queues again the jobs that lost a clash, and (on the keeper) captures
   * colleagues' sources left uncaptured. Skipped while a job holds the brain lock, unless the caller is that job
   * (`lockHeld`). Never throws: a sync error never blocks local work.
   */
  pull(id: string, o: { lockHeld?: boolean } = {}): Promise<void> {
    return this.serial(id, () =>
      this.pullNow(id, o.lockHeld ?? false).catch((e) => this.fail(id, e)),
    );
  }

  /** Sends the commits the server lacks, unless their added text holds a possible secret. Never throws. */
  push(id: string): Promise<void> {
    return this.serial(id, () =>
      this.pushNow(id).catch((e) => this.fail(id, e)),
    );
  }

  /** After git writes to a brain folder: a shared brain pushes once the writes have been quiet for the debounce. */
  afterGit(dir: string): void {
    const key = path.resolve(dir);
    const b = this.d.brains
      .list()
      .find((x) => x.sharing && !x.archived && path.resolve(x.path) === key);
    if (!b) return;
    const id = b.id;
    clearTimeout(this.pushTimers.get(id));
    this.pushTimers.set(
      id,
      setTimeout(() => {
        this.pushTimers.delete(id);
        void this.push(id);
      }, this.d.pushDelayMs ?? PUSH_DELAY_MS),
    );
  }

  /** Pulls every shared brain now, then every tick while its jobs are idle. Returns the stop. */
  start(): () => void {
    const all = (skipBusy: boolean) => {
      for (const b of this.d.brains.list())
        if (b.sharing && !b.archived) {
          if (skipBusy && this.d.runner().running(b.id)) continue;
          void this.pull(b.id);
        }
    };
    all(false);
    const timer = setInterval(() => all(true), this.d.tickMs ?? TICK_MS);
    return () => {
      clearInterval(timer);
      for (const t of this.pushTimers.values()) clearTimeout(t);
      this.pushTimers.clear();
    };
  }

  private async pullNow(id: string, lockHeld: boolean): Promise<void> {
    const b = this.shared(id);
    if (!b) return;
    const dir = b.path;
    if (!lockHeld) {
      // A job of this runner holds the brain (even past the lock's stale hour): it pulls itself before it starts.
      if (this.d.runner().running(id)) return;
      const took = await acquireLock(dir, process.pid, this.now).catch(
        () => false,
      );
      // A job of another process holds the brain.
      if (!took) return;
    }
    try {
      // The job's own pull comes after beforeJob committed them; any other pull commits them here.
      if (!lockHeld) await this.d.commitOutsideEdits(id);
      await server(
        this.d.git.fetch(dir, SERVER, {
          timeoutMs: this.d.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
        }),
      );
      const r = await withBrainGit(dir, () =>
        mergeServer(this.d.git, dir, SERVER, this.now()),
      );
      this.runAgain(id, r.rerun);
      await this.pickUpUncaptured(id, dir);
      const status = this.d.brains.get(id)?.sharing?.status;
      await this.patch(id, {
        lastPullAt: this.now().toISOString(),
        status:
          status === 'held'
            ? 'held'
            : (await this.ahead(dir, await this.base(dir), 'HEAD'))
              ? 'pending'
              : 'ok',
      });
    } finally {
      if (!lockHeld) await releaseLock(dir).catch(() => undefined);
    }
  }

  /** Each job whose output lost a clash goes back to the front of the queue, or fails after its second run again. */
  private runAgain(id: string, refs: JobRef[]) {
    const runner = this.d.runner();
    for (const ref of refs) {
      const last = runner.jobs(id).find((j) => sameJob(j, ref));
      // Queued or running already: it runs on the merged brain.
      if (last && PENDING.has(last.status)) continue;
      const replays = last?.replays ?? 0;
      if (replays >= MAX_REPLAYS) {
        if (last) runner.fail(id, last.id, RAN_AGAIN);
        continue;
      }
      runner.enqueue(id, ref.kind, ref.source, {
        front: true,
        replays: replays + 1,
        ...(ref.kind === 'write' && ref.target ? { target: ref.target } : {}),
        ...(ref.kind === 'settle' && ref.target
          ? { conflict: ref.target }
          : {}),
      });
    }
  }

  /**
   * On the keeper's machine: sources (not the wiki mirror) still uncaptured an hour after their last commit, with no
   * job of this runner on them (queued, running, or one that failed: a person retries that), are captured in the
   * background.
   */
  private async pickUpUncaptured(id: string, dir: string) {
    const installId = this.d.installId;
    if (!installId) return;
    const origin = await readOrigin(dir).catch(() => null);
    if (!origin || !isKeeper(origin, installId)) return;
    const { state } = await readState(dir);
    if (!state) return;
    const files = (
      await this.d.git.run(dir, [
        '-c',
        'core.quotepath=off',
        'ls-files',
        '-z',
        '--',
        'sources',
      ])
    )
      .split('\0')
      .filter((p) => p.endsWith('.md') && !p.startsWith('sources/wiki/'));
    const runner = this.d.runner();
    const jobs = runner.jobs(id);
    for (const p of files) {
      if (state.captured[p]) continue;
      if (
        jobs.some(
          (j) =>
            j.source === p && (PENDING.has(j.status) || j.status === 'failed'),
        )
      )
        continue;
      const at = Number(
        (
          await this.d.git.run(dir, ['log', '-1', '--format=%ct', '--', p])
        ).trim(),
      );
      if (!at || this.now().getTime() - at * 1000 <= UNCAPTURED_MS) continue;
      runner.enqueue(id, 'capture', p, { background: true });
    }
  }

  private async pushNow(id: string): Promise<void> {
    const b = this.shared(id);
    if (!b) return;
    const dir = b.path;
    // One commit id for the check, the scan and the push: a commit made meanwhile waits for the next push.
    let sha = await this.head(dir);
    if (!(await this.ahead(dir, await this.base(dir), sha))) {
      // Nothing waits: no push to hold or to send.
      const status = this.d.brains.get(id)?.sharing?.status;
      if (status === 'held' || status === 'pending')
        await this.patch(id, { status: 'ok', heldFile: null });
      return;
    }
    if (await this.hold(id, dir, sha)) return;
    const send = (c: string) =>
      server(this.d.git.push(dir, 'origin', `${c}:refs/heads/main`));
    try {
      await send(sha);
    } catch (e) {
      if (!(e instanceof ServerError) || !rejected(e)) throw e;
      // Someone pushed first: merge their changes, then send ours on top, once.
      await this.pullNow(id, false);
      sha = await this.head(dir);
      if (await this.hold(id, dir, sha)) return;
      await send(sha);
    }
    await this.patch(id, {
      status: 'ok',
      heldFile: null,
      lastPushAt: this.now().toISOString(),
    });
  }

  /**
   * After a scrub of a held brain: the commits the server lacks become one commit of the tree as it is now, on top of
   * the server's main, so the secret an earlier one added never leaves the machine. Records that named a folded
   * commit (`lastSyncCommit`, a long read's `commit`) move to the new one. Never while a job runs. True when it folded.
   */
  async squashUnsent(id: string): Promise<boolean> {
    const b = this.shared(id);
    if (!b || this.d.runner().running(id)) return false;
    const dir = b.path;
    const git = this.d.git;
    return withBrainGit(dir, async () => {
      const head = await this.head(dir);
      const onServer =
        (await this.base(dir)) === SERVER
          ? (await git.run(dir, ['rev-parse', `${SERVER}^{commit}`])).trim()
          : null;
      const folded = (
        await git.run(dir, [
          'rev-list',
          onServer ? `${onServer}..${head}` : head,
        ])
      )
        .split('\n')
        .filter(Boolean);
      if (!folded.length) return false;
      const tree = (await git.run(dir, ['rev-parse', `${head}^{tree}`])).trim();
      const squash = (
        await git.run(dir, [
          'commit-tree',
          tree,
          ...(onServer ? ['-p', onServer] : []),
          '-m',
          SQUASH_MESSAGE,
        ])
      ).trim();
      await git.run(dir, ['reset', '-q', '--soft', squash]);
      const moved = await moveRecords(dir, folded, squash);
      if (moved.length) {
        await git.run(dir, ['add', '--', ...moved]);
        await git.run(dir, [
          'commit',
          '-q',
          '-m',
          RECORDS_MESSAGE,
          '--',
          ...moved,
        ]);
      }
      return true;
    });
  }

  private async head(dir: string): Promise<string> {
    return (await this.d.git.run(dir, ['rev-parse', 'HEAD'])).trim();
  }

  /** What the brain is compared with: the server's main, or the empty tree before it has one. */
  private async base(dir: string): Promise<string> {
    return this.d.git
      .run(dir, ['rev-parse', '--verify', '-q', `${SERVER}^{commit}`])
      .then(
        () => SERVER,
        () => EMPTY_TREE,
      );
  }

  /** The commits from `base` to `tip` the server lacks: a range for rev-list and log. */
  private range(base: string, tip: string): string {
    return base === EMPTY_TREE ? tip : `${base}..${tip}`;
  }

  private async ahead(
    dir: string,
    base: string,
    tip: string,
  ): Promise<boolean> {
    const n = Number(
      (
        await this.d.git.run(dir, [
          'rev-list',
          '--count',
          this.range(base, tip),
        ])
      ).trim(),
    );
    return n > 0;
  }

  /** Holds the push when a commit the server lacks adds a possible secret; true when held. */
  private async hold(id: string, dir: string, tip: string): Promise<boolean> {
    const file = await this.secretFile(dir, await this.base(dir), tip);
    if (!file) return false;
    await this.patch(id, { status: 'held', heldFile: file });
    return true;
  }

  /**
   * The first file a commit between `base` and `tip` adds a possible secret to, or null. Each commit on its own: a
   * line a later commit took out still goes to the server in the earlier one. A merge adds nothing of its own here
   * (its local side was scanned in the commits it merged).
   */
  private async secretFile(
    dir: string,
    base: string,
    tip: string,
  ): Promise<string | null> {
    const log = await this.d.git.run(dir, [
      '-c',
      'core.quotepath=off',
      'log',
      '-p',
      '--format=',
      '--no-color',
      '--no-ext-diff',
      '-U0',
      this.range(base, tip),
    ]);
    let file: string | null = null;
    let lines: string[] = [];
    let header = false;
    const hit = () => !!file && findSecrets(lines.join('\n')).length > 0;
    for (const line of log.split('\n')) {
      if (line.startsWith('diff --git ')) {
        if (hit()) return file;
        header = true;
        file = null;
        lines = [];
      } else if (header && line.startsWith('+++ ')) {
        const name = unquoteGitPath(line.slice(4).replace(/\t$/, ''));
        file =
          name === '/dev/null'
            ? null
            : name.startsWith('b/')
              ? name.slice(2)
              : name;
      } else if (line.startsWith('@@')) {
        header = false;
      } else if (!header && file && line.startsWith('+')) {
        lines.push(line.slice(1));
      }
    }
    return hit() ? file : null;
  }
}

/** Moves `lastSyncCommit` and the long reads' `commit` off the folded commits onto `to`; the paths it changed. */
async function moveRecords(
  dir: string,
  folded: string[],
  to: string,
): Promise<string[]> {
  const isFolded = (c: unknown) =>
    typeof c === 'string' &&
    c.length >= 4 &&
    folded.some((f) => f.startsWith(c));
  const moved: string[] = [];
  const { state } = await readState(dir);
  if (state && isFolded(state.lastSyncCommit)) {
    await writeState(dir, (s) => ({ ...s, lastSyncCommit: to }));
    moved.push('brain/state.json');
  }
  const file = absPath(dir, READS_RECORD);
  // Read loosely and written back whole: only the commit ids change.
  const raw: unknown = await fs
    .readFile(file, 'utf8')
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => null);
  const reads =
    raw && typeof raw === 'object' ? (raw as { reads?: unknown }).reads : null;
  if (reads && typeof reads === 'object') {
    let changed = false;
    for (const r of Object.values(reads as Record<string, unknown>)) {
      const rec = r as { commit?: unknown } | null;
      if (rec && typeof rec === 'object' && isFolded(rec.commit)) {
        rec.commit = to;
        changed = true;
      }
    }
    if (changed) {
      await fs.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      moved.push(READS_RECORD);
    }
  }
  return moved;
}
