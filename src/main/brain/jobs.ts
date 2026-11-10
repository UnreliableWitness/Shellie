import { randomUUID } from 'node:crypto';
import {
  BRAIN_JOB_TITLE,
  brainTaskId,
  isBookJob,
  SOURCE_JOB_KINDS,
  type BrainAgent,
  type BrainJob,
  type BrainJobKind,
  type BrainModel,
  isBrainModel,
  opencodeModelArg,
} from '../../shared/brain';
import type { Platform } from '../platform/Platform';
import {
  claudeResultWithSession,
  ExitError,
  type runWithInput,
} from '../services/prSummary';
import { opencodeResultWithSession } from './opencodeResult';
import { acquireLock, releaseLock, writeState } from './state';
import { brainOpencodePermission } from './templates';

const MAX_JOBS = 50;

function brainJobFlags(model: BrainModel): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--permission-mode',
    'acceptEdits',
    '--strict-mcp-config',
  ];
}

/** A headless job's own variables on top of the telemetry env: the brain's pseudo task id, as a brain terminal has. */
export function brainJobEnv(
  brainId: string,
  base: Record<string, string>,
): Record<string, string> {
  return {
    ...base,
    SHELLIE_TASK_ID: brainTaskId(brainId),
    SHELLIE_BRAIN_ID: brainId,
  };
}

/** `opencode run` for a job: the brain's command of that kind, json events, and the model only when a valid one is set. */
export function opencodeJobArgs(
  kind: BrainJobKind,
  model: string | null,
): string[] {
  const m = opencodeModelArg(model);
  return [
    'run',
    '--command',
    kind,
    '--format',
    'json',
    '--title',
    `${BRAIN_JOB_TITLE}: ${kind}`,
    ...(m ? ['-m', m] : []),
  ];
}

/**
 * An OpenCode job's env, and the brain terminal's: the brain's own permission rules as the inline config, so an
 * inherited one cannot loosen them; `plugin` (the terminal's attention plugin) is loaded through it too.
 */
export function opencodeJobEnv(
  base: Record<string, string>,
  plugin: string | null = null,
): Record<string, string> {
  return {
    ...base,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: brainOpencodePermission(),
      ...(plugin ? { plugin: [plugin] } : {}),
    }),
  };
}

/** Why an OpenCode run failed: the error event it printed, or that the program is missing. */
function opencodeFailure(e: unknown): Error {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || (e instanceof ExitError && e.exitCode === 127))
    return new Error('OpenCode (opencode) was not found');
  if (e instanceof ExitError && e.stdout.trim()) {
    try {
      opencodeResultWithSession(e.stdout);
    } catch (parsed) {
      if ((parsed as Error).message.startsWith('OpenCode stopped'))
        return parsed as Error;
    }
  }
  return new Error(`OpenCode stopped (${(e as Error).message})`);
}

/** What OpenCode gets on stdin: the command's argument, the prompt without its leading `/<kind>`. */
function opencodeInput(kind: BrainJobKind, input: string): string {
  if (input === `/${kind}`) return '';
  return input.startsWith(`/${kind} `) ? input.slice(kind.length + 2) : input;
}

export type BrainJobDeps = {
  platform: Pick<Platform, 'claudeCommand' | 'opencodeCommand'>;
  run: typeof runWithInput;
  /** The full environment of the spawned process. */
  env: (brainId: string) => Record<string, string>;
  tokensToday: (brainId: string) => number;
  cap: (brainId: string) => number;
  brainDir: (brainId: string) => string;
  /** The Claude Code model. */
  model: (brainId: string) => BrainModel;
  /** The agent a job of the brain runs on. */
  agent: (brainId: string) => BrainAgent;
  /** The OpenCode model (`provider/model`); null is OpenCode's own default. */
  opencodeModel: (brainId: string) => string | null;
  /** False while the brain's skills are too old for its agent: its jobs wait (no run, no timer) until release. */
  ready: (brainId: string) => boolean;
  onChange: (brainId: string, jobs: BrainJob[]) => void;
  /** Commits the job's output (wiki/, index.md, log.md, state); a throw fails the job. */
  commit: (brainId: string, message: string) => Promise<void>;
  /**
   * Runs with the lock held, before the skill: commits edits made outside a job (so the job's commit never sweeps
   * them in). A throw fails the job.
   */
  beforeJob: (brainId: string) => Promise<void>;
  /**
   * Runs with the lock held, after beforeJob: undefined keeps the default prompt, a string replaces it, null ends the
   * job done without running Claude. A throw fails the job.
   */
  promptFor?: (job: BrainJob) => Promise<string | null | undefined>;
  /** Called once per finished job (done or failed); a throw is logged, never breaks the queue. */
  afterJob?: (job: BrainJob) => void;
  /** Called when a held lock arms the retry timer (tests wait for it). */
  onLockRetry?: (brainId: string) => void;
  timeoutMs?: number;
  lockRetryMs?: number;
  now?: () => Date;
};

type Lane = {
  /** Newest first, for display. */
  list: BrainJob[];
  /** Execution order. */
  queue: BrainJob[];
  busy: boolean;
  /** The job being executed (its status may still read queued until the lock is taken). */
  current: BrainJob | null;
  paused: boolean;
  /** Queued jobs wait for Update skills. */
  held: boolean;
  retry: ReturnType<typeof setTimeout> | null;
};

const prompt = (j: BrainJob) =>
  isBookJob(j)
    ? '/sync book'
    : j.source
      ? `/${j.kind} ${j.source}`
      : `/${j.kind}`;

/** Runs the brain's skills headless, one job at a time per brain (brains in parallel). */
export class BrainJobRunner {
  private lanes = new Map<string, Lane>();
  private stopped = false;
  private seq = 0;

  constructor(private deps: BrainJobDeps) {}

  private lane(id: string): Lane {
    let l = this.lanes.get(id);
    if (!l) {
      l = {
        list: [],
        queue: [],
        busy: false,
        current: null,
        paused: false,
        held: false,
        retry: null,
      };
      this.lanes.set(id, l);
    }
    return l;
  }

  private now = () => (this.deps.now ?? (() => new Date()))();

  private make(
    brainId: string,
    kind: BrainJobKind,
    source: string | null,
    background = false,
    model: string | null = null,
  ): BrainJob {
    return {
      id: `${brainId}:${randomUUID()}:${++this.seq}`,
      brainId,
      kind,
      source,
      status: 'queued',
      startedAt: null,
      endedAt: null,
      sessionId: null,
      result: null,
      error: null,
      background,
      agent: this.agentOf(brainId),
      model,
    };
  }

  /** The brain's agent; Claude when the brain is gone (the job then fails on its folder, as before). */
  private agentOf(brainId: string): BrainAgent {
    try {
      return this.deps.agent(brainId);
    } catch {
      return 'claude';
    }
  }

  /** Whether the brain's jobs may run; a throw (a brain that is gone) lets the job start and fail as before. */
  private isReady(brainId: string): boolean {
    try {
      return this.deps.ready(brainId);
    } catch {
      return true;
    }
  }

  private changed(brainId: string) {
    try {
      this.deps.onChange(brainId, [...this.lane(brainId).list]);
    } catch (e) {
      // A listener (an IPC send to a closed window) must never break the queue.
      console.error('brain onChange failed', e);
    }
  }

  private finished(job: BrainJob) {
    try {
      this.deps.afterJob?.(job);
    } catch (e) {
      console.error('brain afterJob failed', e);
    }
  }

  enqueue(
    brainId: string,
    kind: BrainJobKind,
    source: string | null = null,
    opts?: { background?: boolean; model?: string | null },
  ): BrainJob {
    const withSource = SOURCE_JOB_KINDS.has(kind);
    if (withSource && !source) throw new Error(`A ${kind} needs a source file`);
    const l = this.lane(brainId);
    const job = this.make(
      brainId,
      kind,
      withSource ? source : null,
      opts?.background ?? false,
      opts?.model ?? null,
    );
    // A pictures job queued by hand replaces a background one still waiting for the same source: one run, not two.
    if (kind === 'pictures' && !job.background) {
      const gone = l.queue.filter(
        (j) =>
          j.background &&
          j.kind === 'pictures' &&
          j.source === job.source &&
          (j.status === 'queued' || j.status === 'paused') &&
          j !== l.current,
      );
      l.queue = l.queue.filter((j) => !gone.includes(j));
      l.list = l.list.filter((j) => !gone.includes(j));
    }
    l.queue.push(job);
    this.add(l, job);
    this.changed(brainId);
    this.pump(brainId);
    return job;
  }

  private add(l: Lane, job: BrainJob) {
    l.list.unshift(job);
    this.trim(l);
  }

  /** Drops the oldest finished jobs beyond the limit. */
  private trim(l: Lane) {
    while (l.list.length > MAX_JOBS) {
      const i = l.list.findLastIndex(
        (j) => j.status === 'done' || j.status === 'failed',
      );
      if (i < 0) break;
      l.list.splice(i, 1);
    }
  }

  jobs(brainId: string): BrainJob[] {
    return [...this.lane(brainId).list];
  }

  /** Forgets the queued (not running) jobs on a source that is being removed; returns how many. */
  dropQueued(brainId: string, source: string): number {
    const l = this.lane(brainId);
    const gone = l.queue.filter(
      (j) =>
        (j.status === 'queued' || j.status === 'paused') &&
        j.source === source &&
        j !== l.current,
    );
    if (!gone.length) return 0;
    l.queue = l.queue.filter((j) => !gone.includes(j));
    l.list = l.list.filter((j) => !gone.includes(j));
    // Nothing left to wait for Update skills.
    if (!l.queue.some((j) => j.status === 'queued')) l.held = false;
    this.changed(brainId);
    return gone.length;
  }

  running(brainId: string): boolean {
    return this.lane(brainId).busy;
  }

  /** Whether queued jobs wait for Update skills (an OpenCode brain on skills older than v7). */
  held(brainId: string): boolean {
    return this.lane(brainId).held;
  }

  /** Lets held jobs start once the skills or the agent changed; they stay held while the brain is still not ready. */
  release(brainId: string): void {
    const l = this.lane(brainId);
    if (!l.held) return;
    l.held = false;
    this.changed(brainId);
    this.pump(brainId);
  }

  resume(brainId: string): void {
    const l = this.lane(brainId);
    if (!l.paused) return;
    l.paused = false;
    for (const j of l.list) if (j.status === 'paused') j.status = 'queued';
    this.changed(brainId);
    this.pump(brainId);
  }

  stop(): void {
    this.stopped = true;
    for (const l of this.lanes.values()) {
      if (l.retry) clearTimeout(l.retry);
      l.retry = null;
    }
  }

  private pump(brainId: string): void {
    const l = this.lane(brainId);
    if (this.stopped || l.busy || l.paused || l.retry) return;
    // Background jobs wait until nothing else is queued.
    const job =
      l.queue.find((j) => j.status === 'queued' && !j.background) ??
      l.queue.find((j) => j.status === 'queued');
    if (!job) return;
    if (!this.isReady(brainId)) {
      // Held, not failed: no timer; release starts the queue again.
      if (!l.held) {
        l.held = true;
        this.changed(brainId);
      }
      return;
    }
    if (l.held) {
      l.held = false;
      this.changed(brainId);
    }
    // The job runs on the agent the brain has now (it may have switched while the job waited).
    job.agent = this.agentOf(brainId);
    l.busy = true;
    l.current = job;
    void this.execute(brainId, l, job).finally(() => {
      l.busy = false;
      l.current = null;
      this.pump(brainId);
    });
  }

  private async execute(
    brainId: string,
    l: Lane,
    job: BrainJob,
  ): Promise<void> {
    const d = this.deps;
    const done = () => {
      l.queue = l.queue.filter((j) => j !== job);
    };
    let dir: string;
    try {
      dir = d.brainDir(brainId);
      if (d.tokensToday(brainId) >= d.cap(brainId)) {
        job.status = 'paused';
        l.paused = true;
        this.changed(brainId);
        return;
      }
    } catch (e) {
      job.status = 'failed';
      job.error = (e as Error).message;
      job.endedAt = this.now().toISOString();
      done();
      this.changed(brainId);
      this.finished(job);
      return;
    }
    let locked = false;
    try {
      locked = await acquireLock(dir, process.pid, d.now);
    } catch {
      locked = false;
    }
    if (!locked) {
      l.retry = setTimeout(() => {
        l.retry = null;
        this.pump(brainId);
      }, d.lockRetryMs ?? 5000);
      d.onLockRetry?.(brainId);
      return;
    }
    try {
      job.status = 'running';
      job.startedAt = this.now().toISOString();
      this.changed(brainId);
      await d.beforeJob(brainId);
      const input = await d.promptFor?.(job);
      if (input === null) {
        // Nothing for the agent to do: nothing changed, so there is nothing to commit.
        job.result = 'Nothing to re-evaluate';
      } else {
        await this.runSkill(brainId, dir, job, input ?? prompt(job));
      }
      job.status = 'done';
    } catch (e) {
      job.status = 'failed';
      job.error = (e as Error).message;
    } finally {
      job.endedAt = this.now().toISOString();
      await releaseLock(dir).catch(() => undefined);
      done();
    }
    if (job.kind === 'capture' && job.status === 'done') {
      const lint = this.make(brainId, 'lint', null);
      l.queue.unshift(lint);
      this.add(l, lint);
    }
    this.trim(l);
    this.changed(brainId);
    this.finished(job);
  }

  /** Runs the skill headless, records a capture, and commits the output; a throw fails the job. */
  private async runSkill(
    brainId: string,
    dir: string,
    job: BrainJob,
    input: string,
  ): Promise<void> {
    const d = this.deps;
    const timeoutMs = d.timeoutMs ?? 600_000;
    let result: string;
    let sessionId: string | null;
    if (job.agent === 'opencode') {
      const stdout = await d
        .run(
          d.platform.opencodeCommand(
            undefined,
            opencodeJobArgs(
              job.kind,
              opencodeModelArg(job.model) ?? d.opencodeModel(brainId),
            ),
          ),
          {
            cwd: dir,
            input: opencodeInput(job.kind, input),
            timeoutMs,
            env: opencodeJobEnv(d.env(brainId)),
          },
        )
        .catch((e: unknown) => {
          throw opencodeFailure(e);
        });
      ({ result, sessionId } = opencodeResultWithSession(stdout));
    } else {
      const stdout = await d.run(
        d.platform.claudeCommand(
          null,
          brainJobFlags(
            job.model && isBrainModel(job.model) ? job.model : d.model(brainId),
          ),
        ),
        { cwd: dir, input, timeoutMs, env: d.env(brainId) },
      );
      ({ result, sessionId } = claudeResultWithSession(stdout));
    }
    job.result = result;
    job.sessionId = sessionId;
    // A capture and a lessons run both fold a source into the wiki: the source is captured.
    if ((job.kind === 'capture' || job.kind === 'lessons') && job.source) {
      const source = job.source;
      const at = this.now().toISOString();
      await writeState(dir, (s) => ({
        ...s,
        captured: { ...s.captured, [source]: { at, sessionId } },
      }));
    }
    await d.commit(
      brainId,
      `Brain: ${job.kind}${job.source ? ` ${job.source}` : ''}`,
    );
  }
}
