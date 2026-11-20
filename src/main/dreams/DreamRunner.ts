/**
 * One dream, end to end (spec sections 3 to 5): a hidden worktree on a new local `dream/<date>-<n>` branch, a propose
 * run and a check run of OpenCode in it, the model rule after each, and Shellie's own commits of what passed. Runs
 * unattended: every outcome but `proposed` removes what the dream made (never anything else).
 *
 * Session text (run output, the report), paths and git's own errors never go into a failure reason or the journal:
 * reasons are short fixed phrases.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  DreamEvidence,
  DreamJournalEntry,
  DreamProposal,
  DreamResult,
  DreamSighting,
} from '../../shared/dreams';
import type { Platform } from '../platform/Platform';
import { GitError, type GitClient } from '../services/GitClient';
import type { runWithInput } from '../services/prSummary';
import type { DreamStore } from './DreamStore';
import {
  changedPaths,
  commitFiles,
  commitSubject,
  dreamDate,
  nextDreamId,
  removeDream,
  revertPaths,
  sameSnapshot,
  snapshot,
  unattendedConfig,
  type DreamMade,
} from './dreamGit';
import {
  abortable,
  DreamFailed,
  runReason,
  sessionOf,
  settledWithin,
  taskRef,
} from './dreamRun';
import {
  pickMaterial,
  writeMaterial,
  type Material,
  type TaskSessions,
} from './material';
import { dreamArgs, dreamEnv, otherModels } from './opencodeDream';
import { checkPrompt, proposePrompt } from './prompts';
import {
  groupProposals,
  readReport,
  splitAllowed,
  type DreamReport,
} from './report';

export const DREAM_RUN_TIMEOUT_MS = 30 * 60_000;
/** How often the day's limit is checked during a run. */
const LIMIT_CHECK_MS = 30_000;
/** How long a stopped run may take to end before its folders are removed anyway. */
export const RUN_GRACE_MS = 10_000;
const MAX_PROPOSALS = 3;

/** The reasons a dream fails for (besides those of a run, `runReason`). */
const REASON = {
  sessions: 'The sessions could not be read',
  taken: 'A dream of that name already exists',
  worktree: 'git could not create the worktree',
  target: 'the target branch was not found',
  changes: 'git could not read the changes',
  undo: 'git could not undo a change',
  commit: 'git could not commit',
  remove: 'git could not remove the dream',
  report: 'The dream left no readable report',
  checkEdited: 'The check run changed files',
  saved: 'The dream could not be saved',
  other: 'Shellie could not finish the dream',
};

export type DreamOutcome =
  | { outcome: 'proposed'; result: DreamResult }
  | { outcome: 'nothing' }
  | { outcome: 'interrupted'; why: 'stopped' | 'limit' | 'suspend' }
  | { outcome: 'wrong-model'; answered: string[] }
  | { outcome: 'failed'; reason: string };

export type DreamRunnerDeps = {
  git: GitClient;
  platform: Pick<Platform, 'opencodeCommand'>;
  /**
   * Runs a command with stdin. It MUST kill the process when `signal` aborts (`runWithInput` does; the production
   * helper is made to). The runner still waits at most `RUN_GRACE_MS` for a stopped run before removing its folders.
   */
  run: typeof runWithInput;
  store: DreamStore;
  dreamsDir: string;
  sessionsOf: (repoId: string) => Promise<TaskSessions[]>;
  /** The models of every assistant message of the session and its child sessions. */
  sessionModels: (sessionId: string) => string[];
  /** Tokens of dream sessions between the two times (ms). */
  dreamTokens: (since: number, until: number) => number;
  /** The repo's PR target branch (`main`), as its tasks branch from it. */
  baseBranch: (repo: DreamRepoArg) => Promise<string>;
  now: () => number;
  /** Polled every 30 s during a dream; true stops it with `why: 'limit'`. */
  overLimit: () => boolean;
};

type DreamRepoArg = { id: string; path: string; name: string };
type Running = {
  repoId: string;
  startedAt: number;
  step: 'reading' | 'checking';
};
type Why = 'stopped' | 'limit' | 'suspend';

/** Ends a dream early with this outcome. */
class Ended extends Error {
  constructor(readonly outcome: DreamOutcome) {
    super(outcome.outcome);
  }
}

/** What one dream holds while it runs. */
type Dream = {
  repo: DreamRepoArg;
  model: string;
  folders: string[];
  material: Material;
  startedAt: number;
  stop: AbortController;
  id: string;
  branch: string;
  worktree: string;
  dataDir: string;
  /** What this dream made, and so may remove. */
  made: DreamMade;
  sightings: DreamReport['sightings'];
  removedByCheck: number;
};

/** Runs `fn`; any failure but an ending becomes `reason`. */
async function step<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Ended || e instanceof DreamFailed) throw e;
    throw new DreamFailed(reason);
  }
}

export class DreamRunner {
  private current: Running | null = null;

  constructor(private readonly deps: DreamRunnerDeps) {}

  running(): Running | null {
    return this.current && { ...this.current };
  }

  /** Runs one dream for the repo. Never throws; cleans up on every outcome but 'proposed'. */
  async dream(
    repo: DreamRepoArg,
    o: { model: string; folders: string[]; signal: AbortSignal },
  ): Promise<DreamOutcome> {
    // One at a time: a second call is refused, not a dream; it touches nothing.
    if (this.current)
      return { outcome: 'failed', reason: 'A dream is already running' };
    const startedAt = this.deps.now();
    this.current = { repoId: repo.id, startedAt, step: 'reading' };
    try {
      return await this.dreamOnce(repo, o, startedAt);
    } finally {
      this.current = null;
    }
  }

  private async dreamOnce(
    repo: DreamRepoArg,
    o: { model: string; folders: string[]; signal: AbortSignal },
    startedAt: number,
  ): Promise<DreamOutcome> {
    const d = this.deps;
    const m: Dream = {
      repo,
      model: o.model,
      folders: o.folders,
      material: { tasks: [], marks: {} },
      startedAt,
      stop: new AbortController(),
      id: `${dreamDate(startedAt)}-0`,
      branch: '',
      worktree: '',
      dataDir: '',
      made: { dir: null, worktree: null, branch: null },
      sightings: [],
      removedByCheck: 0,
    };
    try {
      m.material = pickMaterial(
        await d.sessionsOf(repo.id),
        d.store.repo(repo.id).covered,
      );
    } catch {
      return this.settle(m, { outcome: 'failed', reason: REASON.sessions });
    }
    if (m.material.tasks.length === 0) return { outcome: 'nothing' };

    const stop = m.stop;
    const onAbort = () =>
      stop.abort(o.signal.reason === 'suspend' ? 'suspend' : 'stopped');
    if (o.signal.aborted) onAbort();
    o.signal.addEventListener('abort', onAbort, { once: true });
    const poll = setInterval(() => {
      try {
        if (d.overLimit()) stop.abort('limit');
      } catch {
        // a failed usage read is checked again next time
      }
    }, LIMIT_CHECK_MS);
    let outcome: DreamOutcome;
    try {
      outcome = await this.attempt(m);
    } catch (e) {
      outcome =
        e instanceof Ended
          ? e.outcome
          : {
              outcome: 'failed',
              reason: e instanceof DreamFailed ? e.reason : REASON.other,
            };
    } finally {
      clearInterval(poll);
      o.signal.removeEventListener('abort', onAbort);
    }
    return this.settle(m, outcome);
  }

  private async attempt(m: Dream): Promise<DreamOutcome> {
    const d = this.deps;
    const { git } = d;
    const repoPath = m.repo.path;
    this.checkStop(m);

    const target = await d.baseBranch(m.repo);
    const fetched = await git
      .fetch(repoPath, `origin/${target}`, { unattended: true })
      .then(
        () => true,
        () => false,
      );
    const remoteRef = `refs/remotes/origin/${target}`;
    const baseSha = await step(REASON.target, async () => {
      const ref =
        fetched && (await git.commitExists(repoPath, remoteRef))
          ? remoteRef
          : (await git.branchExists(repoPath, target))
            ? `refs/heads/${target}`
            : remoteRef;
      const sha = await git.resolveBase(repoPath, {
        baseRef: ref,
        baseSha: ref,
      });
      if (!sha) throw new DreamFailed(REASON.target);
      return sha;
    });
    this.checkStop(m);

    const repoDir = path.join(d.dreamsDir, m.repo.id);
    // Nor an id the journal names: a stopped or discarded dream leaves no branch or folder, but keeps its line.
    const journaled = new Set(
      d.store
        .journal()
        .filter((e) => e.repoId === m.repo.id)
        .map((e) => e.dreamId),
    );
    m.id = await nextDreamId(git, repoPath, repoDir, m.startedAt, journaled);
    const dir = path.join(repoDir, m.id);
    m.branch = `dream/${m.id}`;
    // A folder or branch that is there already is not this dream's: it fails and leaves them alone.
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(dir).catch(() => {
      throw new DreamFailed(REASON.taken);
    });
    m.made.dir = dir;
    const hooks = path.join(dir, 'hooks');
    await fs.mkdir(hooks);
    await fs.mkdir(path.join(dir, 'data'));
    const config = unattendedConfig(hooks);
    if (await git.branchExists(repoPath, m.branch))
      throw new DreamFailed(REASON.taken);
    const worktree = path.join(dir, 'wt');
    try {
      await git.worktreeAdd(repoPath, {
        branch: m.branch,
        path: worktree,
        baseRef: baseSha,
        config,
      });
    } catch (e) {
      // Not there a moment ago: unless git says it is someone else's now, a half-made branch is this dream's.
      const taken = e instanceof GitError && /already exists/i.test(e.stderr);
      if (!taken) m.made = { ...m.made, branch: m.branch, worktree };
      throw new DreamFailed(taken ? REASON.taken : REASON.worktree);
    }
    m.worktree = await fs.realpath(worktree);
    m.made = { ...m.made, branch: m.branch, worktree: m.worktree };
    m.dataDir = await fs.realpath(path.join(dir, 'data'));
    await writeMaterial(m.dataDir, m.material, d.store.repo(m.repo.id));
    const changes = () =>
      step(REASON.changes, async () => {
        const paths = await changedPaths(git, m.worktree, config);
        return { paths, snap: await snapshot(m.worktree, paths) };
      });

    await this.opencode(
      m,
      'propose',
      proposePrompt({
        dataDir: m.dataDir,
        folders: m.folders,
        maxProposals: MAX_PROPOSALS,
      }),
    );
    const proposed = await this.report(m);
    m.sightings = proposed.sightings;
    if (proposed.proposals.length === 0) return { outcome: 'nothing' };
    const before = await changes();

    if (this.current) this.current.step = 'checking';
    await this.opencode(
      m,
      'check',
      checkPrompt({ dataDir: m.dataDir, folders: m.folders }),
    );
    const checked = await this.report(m);
    this.checkStop(m);
    const after = await changes();
    if (!sameSnapshot(before.snap, after.snap))
      throw new DreamFailed(REASON.checkEdited);

    const { allowed, outside } = splitAllowed(after.paths, m.folders);
    const { groups, unlisted, removedByCheck } = groupProposals(
      checked,
      allowed,
      true,
    );
    m.removedByCheck = removedByCheck;
    await step(REASON.undo, () =>
      revertPaths(git, m.worktree, baseSha, [...outside, ...unlisted], config),
    );
    if (groups.length === 0) return { outcome: 'nothing' };

    const proposals: DreamProposal[] = [];
    for (const [i, g] of groups.entries()) {
      const commit = await step(REASON.commit, () =>
        commitFiles(git, m.worktree, {
          files: g.files,
          subject: commitSubject(g.title),
          body: g.why,
          config,
        }),
      );
      proposals.push({
        id: `p${i + 1}`,
        kind: g.kind,
        title: g.title,
        why: g.why,
        evidence: g.evidence.map((e): DreamEvidence => ({
          ...taskRef(e.task, m.material.tasks),
          date: e.date,
          quote: e.quote,
        })),
        files: g.files,
        commit,
        dropped: false,
      });
    }
    return {
      outcome: 'proposed',
      result: {
        id: m.id,
        repoId: m.repo.id,
        branch: m.branch,
        baseSha,
        worktreePath: m.worktree,
        dataDir: m.dataDir,
        at: new Date(d.now()).toISOString(),
        model: m.model,
        tokens: 0, // set when settled, for the whole run window
        sessions: m.material.tasks.reduce((n, t) => n + t.sessions.length, 0),
        proposals,
        reverted: outside,
        removedByCheck,
      },
    };
  }

  /** Throws the interruption once the dream was stopped. */
  private checkStop(m: Dream): void {
    if (m.stop.signal.aborted)
      throw new Ended({
        outcome: 'interrupted',
        why: m.stop.signal.reason as Why,
      });
  }

  /** One OpenCode run in the worktree, then the model rule. The check run may edit only the data folder. */
  private async opencode(
    m: Dream,
    what: 'propose' | 'check',
    prompt: string,
  ): Promise<void> {
    const d = this.deps;
    const cmd = d.platform.opencodeCommand(undefined, dreamArgs(m.model, what));
    // Applied last: spawning spreads process.env, then the env given, then the command's own.
    const env = dreamEnv(cmd.env ?? {}, {
      model: m.model,
      worktree: m.worktree,
      dataDir: m.dataDir,
      readOnlyWorktree: what === 'check',
    });
    const signal = m.stop.signal;
    const running = d.run(
      { ...cmd, env },
      {
        cwd: m.worktree,
        input: prompt,
        timeoutMs: DREAM_RUN_TIMEOUT_MS,
        env,
        signal,
      },
    );
    let stdout: string;
    try {
      stdout = await abortable(running, signal);
    } catch (e) {
      // Stopped: give the process time to end before its folders go.
      if (signal.aborted) await settledWithin(running, RUN_GRACE_MS);
      this.checkStop(m);
      throw new DreamFailed(runReason(e, DREAM_RUN_TIMEOUT_MS));
    }
    this.checkStop(m);
    const session = sessionOf(stdout);
    const others = otherModels(
      session ? d.sessionModels(session) : [],
      m.model,
    );
    if (others.length)
      throw new Ended({ outcome: 'wrong-model', answered: others });
  }

  private async report(m: Dream): Promise<DreamReport> {
    try {
      return await readReport(m.dataDir);
    } catch {
      throw new DreamFailed(REASON.report);
    }
  }

  /**
   * Stores what the outcome means, removes what is not kept, and writes the journal entry. Each store call stands on
   * its own, so one failing loses neither the others nor the journal entry; marks are stored last.
   */
  private async settle(m: Dream, outcome: DreamOutcome): Promise<DreamOutcome> {
    const d = this.deps;
    const { store } = d;
    const repoId = m.repo.id;
    const safe = (fn: () => Promise<unknown> | unknown) =>
      Promise.resolve()
        .then(fn)
        .then(
          () => true,
          () => false,
        );
    let tokens = 0;
    await safe(() => {
      tokens = d.dreamTokens(m.startedAt, d.now());
    });
    const at = new Date(d.now()).toISOString();
    const sightings = (): DreamSighting[] =>
      m.sightings.map((s) => ({
        at,
        note: s.note,
        taskId: taskRef(s.task, m.material.tasks).taskId,
        quote: s.quote,
      }));

    if (outcome.outcome === 'proposed') {
      const { result } = outcome;
      result.tokens = tokens;
      if (!(await safe(() => store.setResult(repoId, result))))
        outcome = { outcome: 'failed', reason: REASON.saved };
    }
    if (outcome.outcome !== 'proposed') {
      const failure = await removeDream(d.git, m.repo.path, m.made).catch(
        (e: unknown) => e,
      );
      if (failure && outcome.outcome === 'nothing')
        outcome = { outcome: 'failed', reason: REASON.remove };
    }
    if (outcome.outcome === 'proposed' || outcome.outcome === 'nothing') {
      const done = outcome.outcome;
      await safe(() => store.addSightings(repoId, sightings()));
      await safe(() => store.succeeded(repoId, done));
      await safe(() => store.markCovered(repoId, m.material.marks));
    } else if (outcome.outcome === 'failed') {
      const { reason } = outcome;
      await safe(() => store.failed(repoId, reason));
    }
    const entry = this.entry(m, outcome, tokens, at);
    await safe(() => store.log(entry));
    return outcome;
  }

  private entry(
    m: Dream,
    o: DreamOutcome,
    tokens: number,
    at: string,
  ): DreamJournalEntry {
    const base = {
      dreamId: m.id,
      repoId: m.repo.id,
      at,
      model: m.model,
      tokens,
      proposals: 0,
      removedByCheck: m.removedByCheck,
      closed: null,
    };
    switch (o.outcome) {
      case 'proposed':
        return {
          ...base,
          outcome: 'proposed',
          reason: null,
          proposals: o.result.proposals.length,
        };
      case 'nothing':
        return { ...base, outcome: 'nothing', reason: null };
      case 'interrupted':
        return {
          ...base,
          outcome: o.why === 'limit' ? 'limit' : 'interrupted',
          reason: o.why,
        };
      case 'wrong-model':
        return {
          ...base,
          outcome: 'wrong-model',
          reason: `answered by ${o.answered.join(', ')}`,
        };
      case 'failed':
        return { ...base, outcome: 'failed', reason: o.reason };
    }
  }
}
