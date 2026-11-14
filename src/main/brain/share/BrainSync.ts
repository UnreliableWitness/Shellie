/**
 * Keeps a shared brain's folder in step with its server repo (the shared-brains spec, "Sync"): pull before jobs and
 * every 15 minutes, push after every brain commit, hold a push that would send a secret, and queue again the jobs
 * whose output lost a clash with a colleague's change. Only fetches, merges and adds commits; the one exception is
 * `squashUnsent`, which folds commits that never left the machine into one after a scrub.
 */
import fs from 'node:fs/promises';
import type { Brain, BrainJob, BrainSharing } from '../../../shared/brain';
import type { TelemetryProps } from '../../../shared/telemetry';
import { samePath } from '../../paths';
import { GitAuthError, type GitClient } from '../../services/GitClient';
import { PENDING } from '../bookPass';
import {
  jobTarget,
  jobTargetOpts,
  SQUASH_MESSAGE,
  type JobRef,
} from '../brainCommits';
import type { BrainStore } from '../BrainStore';
import { withBrainGit } from '../gitMutex';
import type { BrainJobRunner } from '../jobs';
import { TICK_MS } from '../scheduler';
import { absPath } from '../paths';
import { READS_RECORD } from '../reads';
import { readState, withBrainLock } from '../state';
import { readShared } from './files';
import {
  headOf,
  isRecord,
  mapReadCommits,
  parseJsonOrNull,
  SERVER,
  serverBase,
  unsentCount,
  unsentRange,
  withPrivateIndex,
} from './gitUtil';
import { factsFromShared, isAutomatic } from './keeper';
import { mergeServer } from './merge';
import { unsentSecretFile } from './secretScan';

export const RAN_AGAIN =
  'Ran again: a colleague changed the brain at the same time';
/** A job runs again at most this many times after a clash; the next clash fails it (two runs that both clashed). */
const MAX_REPLAYS = 1;
const PUSH_DELAY_MS = 2000;
/** A colleague's source still uncaptured this long after it arrived is captured by the keeper. */
const UNCAPTURED_MS = 3600_000;
/** The brain's history from before it was shared (`shareBrain`), dropped after the first successful pull. */
export const PRE_SHARE_REF = 'refs/shellie/pre-share';

export type SyncRunner = Pick<
  BrainJobRunner,
  'enqueue' | 'jobs' | 'running' | 'fail' | 'release'
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
  /** Telemetry: one `brain.sync` per pull or push that merged, sent, held or failed on the server. Absent: none. */
  event?: (name: string, props?: TelemetryProps) => void;
  now?: () => Date;
  pushDelayMs?: number;
  tickMs?: number;
  /** The secrets scan of the unsent commits (`unsentSecretFile`; tests pass one that fails or races). */
  scanUnsent?: typeof unsentSecretFile;
};

const sameJob = (j: BrainJob, r: JobRef) =>
  j.kind === r.kind && j.source === r.source && jobTarget(j) === r.target;

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

/** What a pull or push did, for `brain.sync`: `replays` is how many jobs that lost a clash were queued again. */
type SyncOutcome = {
  outcome: 'pushed' | 'merged' | 'held';
  replays: number;
};

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
  /** Per brain, the unsent commits the secrets scan already found clean: a later push scans only new ones. */
  private readonly scannedClean = new Map<string, Set<string>>();

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
    if (status === 'unreachable' || status === 'unauthorized')
      this.report({ outcome: status, replays: 0 });
    if (status) await this.patch(id, { status }).catch(() => undefined);
  }

  /** One `brain.sync` event: no names, paths or URLs. */
  private report(r: {
    outcome: SyncOutcome['outcome'] | 'unreachable' | 'unauthorized';
    replays: number;
  }) {
    this.d.event?.('brain.sync', { outcome: r.outcome, replays: r.replays });
  }

  /** Runs a pull or push after the brain's earlier ones; reports what it did, and never throws. */
  private guarded(
    id: string,
    work: () => Promise<SyncOutcome | null>,
  ): Promise<void> {
    return this.serial(id, () =>
      work().then(
        (r) => {
          if (r) this.report(r);
        },
        (e: unknown) => this.fail(id, e),
      ),
    );
  }

  /**
   * Fetches and merges the server's changes, queues again the jobs that lost a clash, and (on the keeper) captures
   * colleagues' sources left uncaptured. Skipped while a job holds the brain lock, unless the caller is that job
   * (`lockHeld`). Never throws: a sync error never blocks local work.
   */
  pull(id: string, o: { lockHeld?: boolean } = {}): Promise<void> {
    return this.guarded(id, () => this.pullNow(id, o.lockHeld ?? false));
  }

  /** Sends the commits the server lacks, unless their added text holds a possible secret. Never throws. */
  push(id: string): Promise<void> {
    return this.guarded(id, () => this.pushNow(id));
  }

  /** After git writes to a brain folder: a shared brain pushes once the writes have been quiet for the debounce. */
  afterGit(dir: string): void {
    const b = this.d.brains
      .list()
      .find((x) => samePath(x.path, dir) && this.shared(x.id));
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

  /** Pulls every shared brain now, one after another, then every tick while its jobs are idle. Returns the stop. */
  start(): () => void {
    const all = async (skipBusy: boolean) => {
      for (const b of this.d.brains.list()) {
        if (!this.shared(b.id)) continue;
        if (skipBusy && this.d.runner().running(b.id)) continue;
        await this.pull(b.id);
      }
    };
    void all(false);
    const timer = setInterval(() => all(true), this.d.tickMs ?? TICK_MS);
    return () => {
      clearInterval(timer);
      for (const t of this.pushTimers.values()) clearTimeout(t);
      this.pushTimers.clear();
    };
  }

  /** Null when skipped or when the server had nothing new. */
  private async pullNow(
    id: string,
    lockHeld: boolean,
  ): Promise<SyncOutcome | null> {
    const b = this.shared(id);
    if (!b) return null;
    const dir = b.path;
    if (lockHeld) return this.merge(id, dir);
    // A job of this runner holds the brain (even past the lock's stale hour): it pulls itself before it starts.
    if (this.d.runner().running(id)) return null;
    // A job of another process holds the brain.
    return withBrainLock(
      dir,
      async () => {
        // A job's own pull comes after beforeJob committed them; any other pull commits them here.
        await this.d.commitOutsideEdits(id);
        return this.merge(id, dir);
      },
      { now: this.now, busy: () => null },
    );
  }

  /** The pull itself: fetch, merge, and what follows from the merge. */
  private async merge(id: string, dir: string): Promise<SyncOutcome | null> {
    const git = this.d.git;
    await server(git.fetch(dir, SERVER, { unattended: true }));
    const r = await withBrainGit(dir, async () => {
      const merged = await mergeServer(git, dir, SERVER, this.now());
      // The history from before the share is no longer needed once a pull went through.
      if (await git.commitExists(dir, PRE_SHARE_REF))
        await git
          .run(dir, ['update-ref', '-d', PRE_SHARE_REF])
          .catch(() => undefined);
      return merged;
    });
    await this.copySharedFacts(id, dir);
    const replays = this.runAgain(id, r.rerun);
    this.captureNotes(id, r.notes);
    await this.pickUpUncaptured(id, dir);
    const status = this.d.brains.get(id)?.sharing?.status;
    await this.patch(id, {
      lastPullAt: this.now().toISOString(),
      status:
        status === 'held'
          ? 'held'
          : (await unsentCount(git, dir)) > 0
            ? 'pending'
            : 'ok',
    });
    return r.merged ? { outcome: 'merged', replays } : null;
  }

  /**
   * The brain facts every machine shares (wiki link, last refresh and digest, skills version) as the server has them
   * now go into the record. A skills version newer than this Shellie knows stops the brain's jobs (`shellieOutdated`),
   * not its pulls.
   */
  private async copySharedFacts(id: string, dir: string) {
    const shared = await readShared(dir).catch((e: unknown) => {
      console.error('[brain] shared facts unreadable', (e as Error).message);
      return null;
    });
    const b = this.d.brains.get(id);
    if (!shared || !b) return;
    const change = factsFromShared(b, shared);
    if (!change) return;
    await this.d.brains.patch(id, change);
    // Jobs held for skills this Shellie did not know, or for OpenCode's, start once the brain is ready again.
    if (change.templatesVersion !== undefined) this.d.runner().release(id);
    this.d.changed(id);
  }

  /**
   * Each job whose output lost a clash goes back to the front of the queue, or fails after its second run again.
   * Returns how many were queued again.
   */
  private runAgain(id: string, refs: JobRef[]): number {
    const runner = this.d.runner();
    let queued = 0;
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
        ...jobTargetOpts(ref.kind, ref.target),
      });
      queued++;
    }
    return queued;
  }

  /**
   * The source notes a merge kept for this machine's outside edits that lost a clash: captured here, where the edit
   * was made (the keeper's hour-later pick-up is for a colleague's source).
   */
  private captureNotes(id: string, notes: string[]) {
    const runner = this.d.runner();
    for (const note of notes) {
      const pending = runner
        .jobs(id)
        .some(
          (j) =>
            j.kind === 'capture' && j.source === note && PENDING.has(j.status),
        );
      if (!pending) runner.enqueue(id, 'capture', note);
    }
  }

  /**
   * On the keeper's machine: sources (not the wiki mirror) still uncaptured an hour after their last commit, with no
   * job of this runner on them (queued, running, or one that failed: a person retries that), are captured in the
   * background.
   */
  private async pickUpUncaptured(id: string, dir: string) {
    const b = this.d.brains.get(id);
    const installId = this.d.installId;
    if (!b || !installId || !isAutomatic(b, installId)) return;
    const { state } = await readState(dir);
    if (!state) return;
    const raw = ['-c', 'core.quotepath=off'];
    const files = (
      await this.d.git.run(dir, [...raw, 'ls-files', '-z', '--', 'sources'])
    )
      .split('\0')
      .filter((p) => p.endsWith('.md') && !p.startsWith('sources/wiki/'));
    const runner = this.d.runner();
    const jobs = runner.jobs(id);
    const waiting = files.filter(
      (p) =>
        !state.captured[p] &&
        !jobs.some(
          (j) =>
            j.source === p && (PENDING.has(j.status) || j.status === 'failed'),
        ),
    );
    if (!waiting.length) return;
    const last = await this.lastCommitTimes(dir);
    for (const p of waiting) {
      const at = last.get(p) ?? 0;
      if (!at || this.now().getTime() - at * 1000 <= UNCAPTURED_MS) continue;
      runner.enqueue(id, 'capture', p, { background: true });
    }
  }

  /** The time (seconds) of the newest commit that touched each path under sources/, from one `git log`. */
  private async lastCommitTimes(dir: string): Promise<Map<string, number>> {
    const log = await this.d.git.run(dir, [
      '-c',
      'core.quotepath=off',
      'log',
      '--format=%x01%ct',
      // A merge names the paths it made itself (a clash's `-local` source), as `git log -- <path>` shows it.
      '--cc',
      '--name-only',
      '--',
      'sources',
    ]);
    const out = new Map<string, number>();
    // Newest first: a path's first commit is its newest.
    for (const block of log.split('\x01').slice(1)) {
      const [time, ...paths] = block.split('\n');
      for (const p of paths)
        if (p && !out.has(p)) out.set(p, Number(time.trim()));
    }
    return out;
  }

  /** Null when nothing waited to be sent. */
  private async pushNow(id: string): Promise<SyncOutcome | null> {
    const b = this.shared(id);
    if (!b) return null;
    const dir = b.path;
    const git = this.d.git;
    // One commit id for the check, the scan and the push: a commit made meanwhile waits for the next push.
    let sha = await headOf(git, dir);
    let base = await serverBase(git, dir);
    if (!(await unsentCount(git, dir, sha, base))) {
      // Nothing waits: no push to hold or to send.
      const status = this.d.brains.get(id)?.sharing?.status;
      if (status === 'held' || status === 'pending')
        await this.patch(id, {
          status: 'ok',
          heldFile: null,
          heldReason: null,
        });
      return null;
    }
    const held: SyncOutcome = { outcome: 'held', replays: 0 };
    if (await this.hold(id, dir, unsentRange(base, sha))) return held;
    let replays = 0;
    const send = (c: string) =>
      server(git.push(dir, 'origin', `${c}:refs/heads/main`));
    try {
      await send(sha);
    } catch (e) {
      if (!(e instanceof ServerError) || !rejected(e)) throw e;
      // Someone pushed first: merge their changes, then send ours on top, once.
      replays = (await this.pullNow(id, false))?.replays ?? 0;
      sha = await headOf(git, dir);
      base = await serverBase(git, dir);
      if (await this.hold(id, dir, unsentRange(base, sha)))
        return { ...held, replays };
      await send(sha);
    }
    // What was scanned has been sent: it is never unsent again.
    this.scannedClean.delete(id);
    await this.patch(id, {
      status: 'ok',
      heldFile: null,
      heldReason: null,
      lastPushAt: this.now().toISOString(),
    });
    return { outcome: 'pushed', replays };
  }

  /**
   * After a scrub of a held brain: the commits the server lacks become one commit of the tree as it is now, on top of
   * the last server commit the brain already holds (the merge base, so no colleague's change is undone), and the secret
   * an earlier one added never leaves the machine. Records that named a folded commit (`lastSyncCommit`, a long read's
   * `commit`) move to that server commit, inside the fold, so `/sync` and the long reads read the folded changes again.
   * Never while a job runs or holds the lock. True when it folded.
   */
  async squashUnsent(id: string): Promise<boolean> {
    const b = this.shared(id);
    if (!b || this.d.runner().running(id)) return false;
    const dir = b.path;
    return withBrainLock(dir, () => withBrainGit(dir, () => this.fold(dir)), {
      now: this.now,
      busy: () => false,
    });
  }

  private async fold(dir: string): Promise<boolean> {
    const git = this.d.git;
    const head = await headOf(git, dir);
    const parent =
      (await serverBase(git, dir)) === SERVER
        ? await git.mergeBase(dir, head, SERVER)
        : null;
    const folded = (
      await git.run(dir, ['rev-list', parent ? `${parent}..${head}` : head])
    )
      .split('\n')
      .filter(Boolean);
    if (!folded.length) return false;
    const records = await movedRecords(git, dir, head, folded, parent);
    // HEAD's tree with the records replaced, built in an index of its own: the person's staged work stays out.
    const tree = records.length
      ? await withPrivateIndex(
          git,
          dir,
          'shellie-fold-index',
          head,
          async (env, index) => {
            try {
              for (const r of records) {
                await fs.writeFile(`${index}.blob`, r.text, 'utf8');
                const blob = (
                  await git.run(dir, ['hash-object', '-w', `${index}.blob`])
                ).trim();
                await git.run(
                  dir,
                  ['update-index', '--cacheinfo', `100644,${blob},${r.path}`],
                  { env },
                );
              }
            } finally {
              await fs.rm(`${index}.blob`, { force: true });
            }
          },
        )
      : (await git.run(dir, ['rev-parse', `${head}^{tree}`])).trim();
    const squash = (
      await git.run(dir, [
        'commit-tree',
        tree,
        ...(parent ? ['-p', parent] : []),
        '-m',
        SQUASH_MESSAGE,
      ])
    ).trim();
    await git.run(dir, ['reset', '-q', '--soft', squash]);
    if (records.length) {
      await git.run(dir, ['reset', '-q', '--', ...records.map((r) => r.path)]);
      // The working copy follows, unless the person changed the file since.
      for (const r of records) {
        const file = absPath(dir, r.path);
        const now = await fs.readFile(file, 'utf8').catch(() => null);
        if (now === r.before) await fs.writeFile(file, r.text, 'utf8');
      }
    }
    return true;
  }

  /**
   * Holds the push when a commit in `range` (the commits the server lacks) adds a possible secret, or when the scan
   * could not run (the commits are never sent unscanned); true when held. Commits found clean are not scanned again.
   */
  private async hold(id: string, dir: string, range: string): Promise<boolean> {
    const clean = this.scannedClean.get(id) ?? new Set<string>();
    this.scannedClean.set(id, clean);
    let file: string | null;
    try {
      file = await (this.d.scanUnsent ?? unsentSecretFile)(dir, range, clean);
    } catch (e) {
      console.error('[brain] secrets scan failed', (e as Error).message);
      await this.patch(id, {
        status: 'held',
        heldFile: null,
        heldReason: 'unchecked',
      });
      return true;
    }
    if (!file) return false;
    await this.patch(id, {
      status: 'held',
      heldFile: file,
      heldReason: 'secret',
    });
    return true;
  }
}

/**
 * `brain/state.json` and `brain/reads.json` as HEAD has them, with `lastSyncCommit` and each long read's `commit` that
 * named a folded commit moved to `to` (null before the server has a main); only the files that changed.
 */
async function movedRecords(
  git: GitClient,
  dir: string,
  head: string,
  folded: string[],
  to: string | null,
): Promise<{ path: string; before: string; text: string }[]> {
  const isFolded = (c: unknown) =>
    typeof c === 'string' &&
    c.length >= 4 &&
    folded.some((f) => f.startsWith(c));
  const out: { path: string; before: string; text: string }[] = [];
  const edit = async (rel: string, change: (v: unknown) => boolean) => {
    const before = await git
      .run(dir, ['show', `${head}:${rel}`])
      .catch(() => null);
    if (before === null) return;
    const value = parseJsonOrNull(before);
    if (change(value))
      out.push({
        path: rel,
        before,
        text: `${JSON.stringify(value, null, 2)}\n`,
      });
  };
  await edit('brain/state.json', (v) => {
    if (!isRecord(v) || !isFolded(v.lastSyncCommit)) return false;
    v.lastSyncCommit = to;
    return true;
  });
  await edit(
    READS_RECORD,
    (v) => mapReadCommits(v, (c) => (isFolded(c) ? to : c)) === true,
  );
  return out;
}
