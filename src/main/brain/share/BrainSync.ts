/**
 * Keeps a shared brain's folder in step with its server repo (the shared-brains spec, "Sync"): pull before jobs and
 * every 15 minutes, push after every brain commit, hold a push that would send a secret, and queue again the jobs
 * whose output lost a clash with a colleague's change. Only fetches, merges and adds commits: nothing is rewritten.
 */
import path from 'node:path';
import type { Brain, BrainJob, BrainSharing } from '../../../shared/brain';
import { isKeeper } from '../../../shared/brainShare';
import { GitAuthError, type GitClient } from '../../services/GitClient';
import type { BrainStore } from '../BrainStore';
import { withBrainGit } from '../gitMutex';
import type { BrainJobRunner } from '../jobs';
import { TICK_MS } from '../scheduler';
import { findSecrets } from '../secrets';
import { acquireLock, readState, releaseLock } from '../state';
import { readOrigin } from './files';
import { mergeServer, type JobRef } from './merge';

export const RAN_AGAIN =
  'Ran again: a colleague changed the brain at the same time';
/** A job runs again at most this many times after a clash; the next clash fails it. */
const MAX_REPLAYS = 2;
const PUSH_DELAY_MS = 2000;
/** A colleague's source still uncaptured this long after it arrived is captured by the keeper. */
const UNCAPTURED_MS = 3600_000;
const SERVER = 'origin/main';
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
  /** This install's id: the keeper picks up colleagues' sources left uncaptured. Absent: never the keeper. */
  installId?: string;
  now?: () => Date;
  pushDelayMs?: number;
  tickMs?: number;
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
      const took = await acquireLock(dir, process.pid, this.now).catch(
        () => false,
      );
      // A job holds the brain: it pulls itself before it starts.
      if (!took) return;
    }
    try {
      await server(this.d.git.fetch(dir, SERVER));
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
            : (await this.ahead(dir, await this.base(dir)))
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
    if (!(await this.ahead(dir, await this.base(dir)))) {
      // Nothing waits: no push to hold or to send.
      const status = this.d.brains.get(id)?.sharing?.status;
      if (status === 'held' || status === 'pending')
        await this.patch(id, { status: 'ok', heldFile: null });
      return;
    }
    if (await this.hold(id, dir)) return;
    const send = () => server(this.d.git.push(dir, 'origin', 'HEAD:main'));
    try {
      await send();
    } catch (e) {
      if (!(e instanceof ServerError) || !rejected(e)) throw e;
      // Someone pushed first: merge their changes, then send ours on top, once.
      await this.pullNow(id, false);
      if (await this.hold(id, dir)) return;
      await send();
    }
    await this.patch(id, {
      status: 'ok',
      heldFile: null,
      lastPushAt: this.now().toISOString(),
    });
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

  private async ahead(dir: string, base: string): Promise<boolean> {
    const range = base === EMPTY_TREE ? 'HEAD' : `${base}..HEAD`;
    const n = Number(
      (await this.d.git.run(dir, ['rev-list', '--count', range])).trim(),
    );
    return n > 0;
  }

  /** Holds the push when the text the server lacks holds a possible secret; true when held. */
  private async hold(id: string, dir: string): Promise<boolean> {
    const file = await this.secretFile(dir, await this.base(dir));
    if (!file) return false;
    await this.patch(id, { status: 'held', heldFile: file });
    return true;
  }

  /** The first file whose lines added since `base` hold a possible secret, or null. */
  private async secretFile(dir: string, base: string): Promise<string | null> {
    const diff = await this.d.git.run(dir, [
      '-c',
      'core.quotepath=off',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U0',
      base,
      'HEAD',
    ]);
    const added = new Map<string, string[]>();
    let file: string | null = null;
    let header = false;
    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git ')) {
        header = true;
        file = null;
      } else if (header && line.startsWith('+++ ')) {
        const name = line.slice(4).replace(/\t$/, '');
        file = name.startsWith('b/') ? name.slice(2) : null;
      } else if (line.startsWith('@@')) {
        header = false;
      } else if (!header && file && line.startsWith('+')) {
        const lines = added.get(file) ?? [];
        lines.push(line.slice(1));
        added.set(file, lines);
      }
    }
    for (const [f, lines] of added)
      if (findSecrets(lines.join('\n')).length) return f;
    return null;
  }
}
