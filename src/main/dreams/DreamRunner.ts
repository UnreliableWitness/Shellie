/**
 * One dream, end to end (spec sections 3 to 5): a hidden worktree on a new local `dream/<date>-<n>` branch, a propose
 * run and a check run of OpenCode in it, the model rule after each, and Shellie's own commits of what passed. Runs
 * unattended: every outcome but `proposed` removes the worktree, the branch and the data folder.
 *
 * Session text (run output, the report) never goes into an error, a log line or a failure reason: reasons are short
 * fixed phrases.
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
import { opencodeResultWithSession } from '../brain/opencodeResult';
import type { Platform } from '../platform/Platform';
import type { GitClient } from '../services/GitClient';
import { programMissing, type runWithInput } from '../services/prSummary';
import type { DreamStore } from './DreamStore';
import {
  changedPaths,
  commitFiles,
  commitSubject,
  dreamDate,
  gitReason,
  nextDreamId,
  removeDream,
  unattendedConfig,
} from './dreamGit';
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
const MAX_PROPOSALS = 3;

export type DreamOutcome =
  | { outcome: 'proposed'; result: DreamResult }
  | { outcome: 'nothing' }
  | { outcome: 'interrupted'; why: 'stopped' | 'limit' | 'suspend' }
  | { outcome: 'wrong-model'; answered: string[] }
  | { outcome: 'failed'; reason: string };

export type DreamRunnerDeps = {
  git: GitClient;
  platform: Pick<Platform, 'opencodeCommand'>;
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
const fail = (reason: string) => new Ended({ outcome: 'failed', reason });

/** What one dream holds while it runs. */
type Dream = {
  repo: DreamRepoArg;
  model: string;
  folders: string[];
  material: Material;
  startedAt: number;
  stop: AbortController;
  id: string;
  dir: string;
  branch: string;
  worktree: string;
  dataDir: string;
  sightings: DreamReport['sightings'];
  removedByCheck: number;
};

/** Rejects with `stopped` once `signal` aborts, without waiting for `p`. */
const abortable = <T>(p: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('stopped'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });

/** Why a run failed, as a fixed phrase: never the program's own output. */
function runReason(e: unknown): string {
  if (programMissing(e)) return 'OpenCode (opencode) was not found';
  if (/timed out/i.test((e as Error | null)?.message ?? ''))
    return `timed out after ${DREAM_RUN_TIMEOUT_MS / 60_000} min`;
  return 'OpenCode stopped';
}

/** The run's session id; a run that printed an error event failed. */
function sessionOf(stdout: string): string | null {
  try {
    return opencodeResultWithSession(stdout).sessionId;
  } catch (e) {
    if ((e as Error).message.startsWith('OpenCode stopped'))
      throw fail('OpenCode stopped');
  }
  // No answer text: the session is still named by its events.
  for (const line of stdout.split('\n')) {
    try {
      const id = (JSON.parse(line) as { sessionID?: unknown } | null)
        ?.sessionID;
      if (typeof id === 'string') return id;
    } catch {
      // not an event
    }
  }
  return null;
}

/** The task a report names: by id (or its digest file, `tasks/<id>.md`), else by label, else the name as given. */
function taskRef(
  ref: string,
  tasks: TaskSessions[],
): { taskId: string; label: string } {
  const file = ref.replace(/^tasks[\\/]/, '').replace(/\.md$/, '');
  const byId =
    tasks.find((t) => t.taskId === ref) ?? tasks.find((t) => t.taskId === file);
  if (byId) return { taskId: byId.taskId, label: byId.label };
  const want = ref.trim().toLowerCase();
  const byLabel =
    tasks.find((t) => t.label.toLowerCase() === want) ??
    (want
      ? tasks
          .filter((t) => {
            const l = t.label.toLowerCase();
            return l !== '' && (l.includes(want) || want.includes(l));
          })
          .sort((a, b) => b.label.length - a.label.length)[0]
      : undefined);
  return byLabel
    ? { taskId: byLabel.taskId, label: byLabel.label }
    : { taskId: ref, label: ref };
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
    const d = this.deps;
    // One at a time; nothing is touched for a second call.
    if (this.current)
      return { outcome: 'failed', reason: 'A dream is already running' };
    let material: Material;
    try {
      material = pickMaterial(
        await d.sessionsOf(repo.id),
        d.store.repo(repo.id).covered,
      );
    } catch {
      return { outcome: 'failed', reason: 'The sessions could not be read' };
    }
    if (material.tasks.length === 0) return { outcome: 'nothing' };

    const startedAt = d.now();
    this.current = { repoId: repo.id, startedAt, step: 'reading' };
    const stop = new AbortController();
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

    const dream: Dream = {
      repo,
      model: o.model,
      folders: o.folders,
      material,
      startedAt,
      stop,
      id: dreamDate(startedAt),
      dir: '',
      branch: '',
      worktree: '',
      dataDir: '',
      sightings: [],
      removedByCheck: 0,
    };
    let outcome: DreamOutcome;
    try {
      outcome = await this.attempt(dream);
    } catch (e) {
      outcome =
        e instanceof Ended
          ? e.outcome
          : {
              outcome: 'failed',
              reason: gitReason(e) ?? 'Shellie could not finish the dream',
            };
    } finally {
      clearInterval(poll);
      o.signal.removeEventListener('abort', onAbort);
    }
    try {
      outcome = await this.settle(dream, outcome);
    } finally {
      this.current = null;
    }
    return outcome;
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
    const ref =
      fetched && (await git.commitExists(repoPath, remoteRef))
        ? remoteRef
        : (await git.branchExists(repoPath, target))
          ? `refs/heads/${target}`
          : remoteRef;
    const baseSha = await git.resolveBase(repoPath, {
      baseRef: ref,
      baseSha: ref,
    });
    if (!baseSha) throw fail(`git: no branch ${target}`);
    this.checkStop(m);

    const repoDir = path.join(d.dreamsDir, m.repo.id);
    m.id = await nextDreamId(git, repoPath, repoDir, m.startedAt);
    m.dir = path.join(repoDir, m.id);
    m.branch = `dream/${m.id}`;
    m.worktree = path.join(m.dir, 'wt');
    const hooks = path.join(m.dir, 'hooks');
    await fs.mkdir(hooks, { recursive: true });
    await fs.mkdir(path.join(m.dir, 'data'));
    const config = unattendedConfig(hooks);
    await git.worktreeAdd(repoPath, {
      branch: m.branch,
      path: m.worktree,
      baseRef: baseSha,
      config,
    });
    m.worktree = await fs.realpath(m.worktree);
    m.dataDir = await fs.realpath(path.join(m.dir, 'data'));
    await writeMaterial(m.dataDir, m.material, d.store.repo(m.repo.id));

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

    if (this.current) this.current.step = 'checking';
    await this.opencode(
      m,
      'check',
      checkPrompt({ dataDir: m.dataDir, folders: m.folders }),
    );
    const checked = await this.report(m);
    this.checkStop(m);

    const { allowed, outside } = splitAllowed(
      await changedPaths(git, m.worktree, config),
      m.folders,
    );
    const { groups, unlisted, removedByCheck } = groupProposals(
      checked,
      allowed,
      true,
    );
    m.removedByCheck = removedByCheck;
    await git.discardPaths(m.worktree, baseSha, [...outside, ...unlisted]);
    if (groups.length === 0) return { outcome: 'nothing' };

    const proposals: DreamProposal[] = [];
    for (const [i, g] of groups.entries()) {
      const commit = await commitFiles(git, m.worktree, {
        files: g.files,
        subject: commitSubject(g.title),
        body: g.why,
        config,
      });
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
    await fs.rm(hooks, { recursive: true, force: true });
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

  /** One OpenCode run in the worktree, then the model rule. */
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
    });
    let stdout: string;
    try {
      stdout = await abortable(
        d.run(
          { ...cmd, env },
          {
            cwd: m.worktree,
            input: prompt,
            timeoutMs: DREAM_RUN_TIMEOUT_MS,
            env,
            signal: m.stop.signal,
          },
        ),
        m.stop.signal,
      );
    } catch (e) {
      this.checkStop(m);
      throw fail(runReason(e));
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
      throw fail('The dream left no readable report');
    }
  }

  /** Stores what the outcome means, removes what is not kept, and writes the journal entry. */
  private async settle(m: Dream, outcome: DreamOutcome): Promise<DreamOutcome> {
    const d = this.deps;
    const store = d.store;
    const repoId = m.repo.id;
    let tokens = 0;
    try {
      tokens = d.dreamTokens(m.startedAt, d.now());
    } catch {
      // unknown usage is logged as 0; the outcome stands
    }
    const at = new Date(d.now()).toISOString();
    const sightings = (): DreamSighting[] =>
      m.sightings.map((s) => ({
        at,
        note: s.note,
        taskId: taskRef(s.task, m.material.tasks).taskId,
        quote: s.quote,
      }));
    const remove = () =>
      m.branch
        ? removeDream(d.git, m.repo.path, {
            dir: m.dir,
            worktree: m.worktree,
            branch: m.branch,
          })
        : Promise.resolve();

    if (outcome.outcome === 'proposed') {
      outcome.result.tokens = tokens;
      try {
        await store.setResult(repoId, outcome.result);
        await store.addSightings(repoId, sightings());
        await store.markCovered(repoId, m.material.marks);
        await store.succeeded(repoId, 'proposed');
      } catch {
        await store.setResult(repoId, null).catch(() => undefined);
        outcome = { outcome: 'failed', reason: 'The dream could not be saved' };
      }
    }
    if (outcome.outcome !== 'proposed') await remove();
    try {
      if (outcome.outcome === 'nothing') {
        await store.addSightings(repoId, sightings());
        await store.markCovered(repoId, m.material.marks);
        await store.succeeded(repoId, 'nothing');
      } else if (outcome.outcome === 'failed') {
        await store.failed(repoId, outcome.reason);
      }
      await store.log(this.entry(m, outcome, tokens, at));
    } catch {
      // The outcome stands; the record is best effort.
    }
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
