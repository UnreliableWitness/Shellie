import { randomUUID } from 'node:crypto';
import {
  brainTaskId,
  SOURCE_JOB_KINDS,
  type BrainJob,
  type BrainJobKind,
  type BrainModel,
} from '../../shared/brain';
import type { Platform } from '../platform/Platform';
import {
  claudeResultWithSession,
  type runWithInput,
} from '../services/prSummary';
import { acquireLock, releaseLock, writeState } from './state';

const MAX_JOBS = 50;

export function brainJobFlags(model: BrainModel): string[] {
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

export type BrainJobDeps = {
  platform: Pick<Platform, 'claudeCommand'>;
  run: typeof runWithInput;
  /** The full environment of the spawned process. */
  env: (brainId: string) => Record<string, string>;
  tokensToday: (brainId: string) => number;
  cap: (brainId: string) => number;
  brainDir: (brainId: string) => string;
  model: (brainId: string) => BrainModel;
  onChange: (brainId: string, jobs: BrainJob[]) => void;
  /** Commits the job's output (wiki/, index.md, log.md, state); a throw fails the job. */
  commit: (brainId: string, message: string) => Promise<void>;
  /**
   * Runs with the lock held, before the skill: commits edits made outside a job (so the job's commit never sweeps
   * them in). A throw fails the job.
   */
  beforeJob: (brainId: string) => Promise<void>;
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
  retry: ReturnType<typeof setTimeout> | null;
};

const prompt = (j: BrainJob) =>
  j.source ? `/${j.kind} ${j.source}` : `/${j.kind}`;

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
    };
  }

  private changed(brainId: string) {
    try {
      this.deps.onChange(brainId, [...this.lane(brainId).list]);
    } catch (e) {
      // A listener (an IPC send to a closed window) must never break the queue.
      console.error('brain onChange failed', e);
    }
  }

  enqueue(
    brainId: string,
    kind: BrainJobKind,
    source: string | null = null,
  ): BrainJob {
    const withSource = SOURCE_JOB_KINDS.has(kind);
    if (withSource && !source) throw new Error(`A ${kind} needs a source file`);
    const l = this.lane(brainId);
    const job = this.make(brainId, kind, withSource ? source : null);
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
      (j) => j.status === 'queued' && j.source === source && j !== l.current,
    );
    if (!gone.length) return 0;
    l.queue = l.queue.filter((j) => !gone.includes(j));
    l.list = l.list.filter((j) => !gone.includes(j));
    this.changed(brainId);
    return gone.length;
  }

  running(brainId: string): boolean {
    return this.lane(brainId).busy;
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
    const job = l.queue.find((j) => j.status === 'queued');
    if (!job) return;
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
      const stdout = await d.run(
        d.platform.claudeCommand(null, brainJobFlags(d.model(brainId))),
        {
          cwd: dir,
          input: prompt(job),
          timeoutMs: d.timeoutMs ?? 600_000,
          env: d.env(brainId),
        },
      );
      const { result, sessionId } = claudeResultWithSession(stdout);
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
  }
}
