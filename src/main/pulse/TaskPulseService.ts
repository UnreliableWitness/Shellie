import {
  PulseSnapshotSchema,
  type PrPulse,
  type PulseSnapshot,
} from '../../shared/pulse';
import type { PullRequestRef } from '../../shared/types';
import { AdoError, type AdoClient } from '../services/AdoClient';
import { JsonFileStore } from '../usage/JsonFileStore';
import { pickPr, toPrPulse } from './prPulse';

export type PulseTarget = {
  connectionId: string;
  project: string;
  repo: string;
};
export type PulseClient = Pick<
  AdoClient,
  | 'me'
  | 'repositoryId'
  | 'pullRequestsForBranch'
  | 'policyEvaluations'
  | 'pullRequestStatuses'
  | 'pullRequestThreads'
>;
type PulseError = 'auth' | 'network' | 'not-found';
export type PulseDeps = {
  file: string;
  /** Open (status !== 'done') tasks and their workspaces with a branch. */
  workspaces: () => {
    taskId: string;
    workspaceId: string;
    repoId: string;
    branch: string;
    openedAt: string | null;
    stored: PullRequestRef | null;
  }[];
  /** Where the repo's PRs go; asked once per repo per refresh. */
  target: (repoId: string) => Promise<PulseTarget | null>;
  client: (connectionId: string) => PulseClient;
  /** Saves a found PR on the workspace when it differs from `stored`. */
  link: (
    taskId: string,
    workspaceId: string,
    ref: PullRequestRef,
  ) => Promise<void>;
  onChanged: (snapshot: PulseSnapshot) => void;
  onRefreshed?: (info: {
    tasks: number;
    durationMs: number;
    errors: PulseError[];
  }) => void;
  now?: () => Date;
  concurrency?: number;
};

const empty = (): PulseSnapshot => ({
  tasks: {},
  error: null,
  checkedAt: null,
});

/** The snapshot without any checkedAt, so a refresh that found nothing new compares equal. */
function essence(s: PulseSnapshot): string {
  return JSON.stringify({
    error: s.error,
    tasks: Object.fromEntries(
      Object.entries(s.tasks).map(([id, ps]) => [
        id,
        ps.map(({ checkedAt: _c, ...rest }) => rest),
      ]),
    ),
  });
}

function kindOf(e: unknown): PulseError {
  if (e instanceof AdoError) {
    if (e.kind === 'unauthorized') return 'auth';
    if (e.kind === 'not-found') return 'not-found';
  }
  return 'network';
}

/** PR, CI and review status per task workspace; one refresh at a time, the last snapshot cached on disk. */
export class TaskPulseService {
  private readonly store: JsonFileStore<PulseSnapshot>;
  private loaded: Promise<unknown> | null = null;
  private running: Promise<PulseSnapshot> | null = null;
  private last: number | null = null;
  private readonly repoIds = new Map<string, Promise<string>>();

  constructor(private readonly d: PulseDeps) {
    this.store = new JsonFileStore<PulseSnapshot>(
      d.file,
      PulseSnapshotSchema,
      empty,
    );
  }

  private load(): Promise<unknown> {
    this.loaded ??= this.store.load().catch(() => undefined);
    return this.loaded;
  }

  async get(): Promise<PulseSnapshot> {
    await this.load();
    return this.store.value;
  }

  refresh(): Promise<PulseSnapshot> {
    this.running ??= this.build().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  lastRefreshAt(): number | null {
    return this.last;
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  private repositoryId(
    connectionId: string,
    client: PulseClient,
    t: PulseTarget,
  ): Promise<string> {
    const key = JSON.stringify([connectionId, t.project, t.repo]);
    let p = this.repoIds.get(key);
    if (!p) {
      p = client.repositoryId(t.project, t.repo);
      this.repoIds.set(key, p);
      p.catch(() => this.repoIds.delete(key));
    }
    return p;
  }

  private async build(): Promise<PulseSnapshot> {
    await this.load();
    const started = Date.now();
    const prev = this.store.value;
    const list = this.d.workspaces();
    const errors: PulseError[] = [];
    const meOf = new Map<string, Promise<string>>();
    const targetOf = new Map<string, Promise<PulseTarget | null>>();
    const tasks: Record<string, PrPulse[]> = {};
    let auth = false;

    const one = async (w: (typeof list)[number]): Promise<PrPulse | null> => {
      const before = prev.tasks[w.taskId]?.find(
        (p) => p.workspaceId === w.workspaceId,
      );
      try {
        let target = targetOf.get(w.repoId);
        if (!target) {
          target = this.d.target(w.repoId);
          target.catch(() => undefined);
          targetOf.set(w.repoId, target);
        }
        const t = await target;
        if (!t) return null;
        const client = this.d.client(t.connectionId);
        let me = meOf.get(t.connectionId);
        if (!me) {
          me = client.me();
          me.catch(() => undefined);
          meOf.set(t.connectionId, me);
        }
        const repositoryId = await this.repositoryId(t.connectionId, client, t);
        const found = pickPr(
          await client.pullRequestsForBranch(t.project, repositoryId, w.branch),
          w.openedAt,
        );
        let evaluations: Awaited<ReturnType<PulseClient['policyEvaluations']>> =
          [];
        let statuses: Awaited<ReturnType<PulseClient['pullRequestStatuses']>> =
          [];
        let threads: Awaited<ReturnType<PulseClient['pullRequestThreads']>> =
          [];
        if (found) {
          // The task list reads CI, review and comments only for active PRs.
          if (found.status === 'active') {
            [evaluations, statuses, threads] = await Promise.all([
              client.policyEvaluations(
                t.project,
                found.projectId,
                found.pullRequestId,
              ),
              client.pullRequestStatuses(
                t.project,
                repositoryId,
                found.pullRequestId,
              ),
              client.pullRequestThreads(
                t.project,
                repositoryId,
                found.pullRequestId,
              ),
            ]);
          }
          const s = w.stored;
          if (
            !s ||
            s.id !== found.pullRequestId ||
            s.status !== found.status ||
            s.isDraft !== found.isDraft ||
            s.url !== found.webUrl
          ) {
            const ref: PullRequestRef = {
              id: found.pullRequestId,
              url: found.webUrl,
              repositoryId,
              project: t.project,
              repo: t.repo,
              status: found.status,
              isDraft: found.isDraft,
            };
            await this.d
              .link(w.taskId, w.workspaceId, ref)
              .catch((e: unknown) =>
                console.error('[pulse] could not link the PR', e),
              );
          }
        }
        return toPrPulse({
          workspaceId: w.workspaceId,
          pr: found,
          evaluations,
          statuses,
          threads,
          me: await me,
          now: this.now(),
        });
      } catch (e) {
        const kind = kindOf(e);
        errors.push(kind);
        if (kind === 'auth') auth = true;
        else console.warn('[pulse] lookup failed', kind);
        return before ?? null;
      }
    };

    const results: (PrPulse | null)[] = Array.from(
      { length: list.length },
      () => null,
    );
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        results[i] = await one(list[i]);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(this.d.concurrency ?? 4, list.length)) },
        worker,
      ),
    );
    list.forEach((w, i) => {
      const p = results[i];
      if (p) (tasks[w.taskId] ??= []).push(p);
    });

    const snapshot: PulseSnapshot = {
      tasks,
      error: auth ? 'auth' : null,
      checkedAt: this.now().toISOString(),
    };
    this.last = Date.now();
    if (essence(snapshot) !== essence(prev)) {
      await this.store
        .update(() => snapshot)
        .catch((e: unknown) => console.error('[pulse] could not save', e));
      try {
        this.d.onChanged(snapshot);
      } catch (e) {
        console.error('[pulse] onChanged failed', e);
      }
    }
    try {
      this.d.onRefreshed?.({
        tasks: Object.keys(tasks).length,
        durationMs: Date.now() - started,
        errors,
      });
    } catch (e) {
      console.error('[pulse] onRefreshed failed', e);
    }
    return snapshot;
  }
}
