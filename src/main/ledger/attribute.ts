import type { BudgetRecord } from '../../shared/budget';
import { tokensOf } from '../../shared/budget';
import type { Attribution, CostRecord } from '../../shared/ledger';
import { LEVEL_RANK } from '../../shared/ledger';
import { brainIdOf } from '../../shared/brain';
import type { Connection, Repo, Task } from '../../shared/types';
import { taskWorkspaces } from '../../shared/workspaces';
import { isInside } from '../paths';

type TaskCtx = {
  id: string;
  /** The task-level attribution with the home repo; null when the task has no connection. */
  base: Extract<Attribution, { level: 'task' }> | null;
  homeRepo: string;
  sessions: string[];
  worktrees: { path: string; repo: string }[];
  /** Open periods as epoch ms; an open end is Infinity. */
  periods: [number, number][];
};
type RepoCtx = {
  name: string;
  organization: string | null;
  project: string | null;
  /** The main checkout and every task worktree of the repo. */
  paths: string[];
};

export type BrainCtx = {
  id: string;
  organization: string;
  project: string;
  /** The brain folder: transcripts of its Claude runs carry a cwd inside it. */
  path: string;
};

/** What attribution needs from the tasks, repos and connections, built once per pass. `key` changes when any of it does. */
export type AttributionContext = {
  key: string;
  tasks: TaskCtx[];
  byId: Map<string, TaskCtx>;
  bySession: Map<string, TaskCtx>;
  repos: RepoCtx[];
  brains: Map<string, BrainCtx>;
};

const workItemNumber = (id: string | undefined): number | null => {
  const n = Number(id);
  return id && Number.isSafeInteger(n) ? n : null;
};

export function attributionContext(
  tasks: Task[],
  repos: Repo[],
  connections: Connection[],
  /** Claude sessions the usage store (OTLP) has for a task: `claude` typed in a shell, a resume with a new id. */
  usageSessions: (taskId: string) => Iterable<string> = () => [],
  /** Brains (a folder per Azure DevOps project); their usage is attributed to the brain, never billable. */
  brains: BrainCtx[] = [],
): AttributionContext {
  const repoById = new Map(repos.map((r) => [r.id, r]));
  const connById = new Map(connections.map((c) => [c.id, c]));
  const taskCtx: TaskCtx[] = tasks.map((t) => {
    const home = repoById.get(t.repoId);
    const conn = connById.get(t.connectionId ?? home?.connectionId ?? '');
    const homeRepo = home?.name ?? '';
    const periods: [number, number][] = (
      t.openPeriods.length > 0
        ? t.openPeriods
        : [{ start: t.createdAt, end: t.finishedAt }]
    ).map((p) => [
      Date.parse(p.start),
      p.end === null ? Infinity : Date.parse(p.end),
    ]);
    return {
      id: t.id,
      base: conn
        ? {
            level: 'task',
            taskId: t.id,
            organization: conn.organizationUrl,
            project: conn.project,
            workItemId: workItemNumber(t.workItem?.id),
            workItemTitle: t.workItem?.title ?? null,
            workItemType: t.workItem?.type ?? null,
            repo: homeRepo,
          }
        : null,
      homeRepo,
      sessions: [
        ...new Set([
          ...[...t.terminals, ...t.closedTerminals].flatMap((x) =>
            x.sessionId ? [x.sessionId] : [],
          ),
          ...usageSessions(t.id),
        ]),
      ],
      worktrees: taskWorkspaces(t).map((w) => ({
        path: w.worktreePath,
        repo: repoById.get(w.repoId)?.name ?? '',
      })),
      periods,
    };
  });
  const repoCtx: RepoCtx[] = repos.map((r) => {
    const conn = r.connectionId ? connById.get(r.connectionId) : undefined;
    return {
      name: r.name,
      organization: conn?.organizationUrl ?? null,
      project: conn?.project ?? null,
      paths: [
        r.path,
        ...tasks.flatMap((t) =>
          taskWorkspaces(t)
            .filter((w) => w.repoId === r.id)
            .map((w) => w.worktreePath),
        ),
      ],
    };
  });
  const bySession = new Map<string, TaskCtx>();
  for (const t of taskCtx) for (const s of t.sessions) bySession.set(s, t);
  return {
    key: JSON.stringify([taskCtx, repoCtx, brains]),
    tasks: taskCtx,
    byId: new Map(taskCtx.map((t) => [t.id, t])),
    bySession,
    repos: repoCtx,
    brains: new Map(brains.map((b) => [b.id, b])),
  };
}

/** The task's attribution naming `repo`; a task without a connection is attributed to that repo instead. */
function forTask(
  t: TaskCtx,
  repo: string,
  ctx: AttributionContext,
): Attribution {
  if (t.base) return { ...t.base, repo };
  const r = ctx.repos.find((x) => x.name === repo);
  return {
    level: 'repo',
    organization: r?.organization ?? null,
    project: r?.project ?? null,
    repo,
  };
}

/** The task a record belongs to (by task id, a Claude session of its tabs or usage, or OpenCode folder within an open period), and the repo it names. */
export function taskOf(
  r: BudgetRecord,
  ctx: AttributionContext,
): { t: TaskCtx; repo: string } | null {
  const byId = r.taskId ? ctx.byId.get(r.taskId) : undefined;
  if (byId) return { t: byId, repo: byId.homeRepo };
  if (r.tool === 'claude-code') {
    const t = ctx.bySession.get(r.sessionId);
    if (t) return { t, repo: t.homeRepo };
  }
  const cwd = r.cwd;
  if (!cwd || r.tool !== 'opencode') return null;
  const at = Date.parse(r.at);
  let best: { t: TaskCtx; repo: string; len: number } | null = null;
  for (const t of ctx.tasks) {
    if (!t.periods.some(([s, e]) => at >= s && at <= e)) continue;
    for (const w of t.worktrees)
      if (isInside(w.path, cwd) && (!best || w.path.length > best.len))
        best = { t, repo: w.repo, len: w.path.length };
  }
  return best ? { t: best.t, repo: best.repo } : null;
}

/** The known brain a record belongs to: by its `brain:` task id, else by a cwd inside the brain folder (longest path wins). */
function brainOf(r: BudgetRecord, ctx: AttributionContext): BrainCtx | null {
  const id = brainIdOf(r.taskId);
  const byId = id === null ? undefined : ctx.brains.get(id);
  if (byId) return byId;
  const cwd = r.cwd;
  if (!cwd) return null;
  let best: BrainCtx | null = null;
  for (const b of ctx.brains.values())
    if (isInside(b.path, cwd) && (!best || b.path.length > best.path.length))
      best = b;
  return best;
}

/** Whether a record is brain usage, also when its brain is unknown (deleted, not loaded yet): such a record is never billable. */
export function isBrainRecord(
  r: BudgetRecord,
  ctx: AttributionContext,
): boolean {
  return brainIdOf(r.taskId) !== null || brainOf(r, ctx) !== null;
}

/** Task (see taskOf), else repo by folder, else none. */
export function attribute(
  r: BudgetRecord,
  ctx: AttributionContext,
): Attribution {
  const brain = brainOf(r, ctx);
  if (brain)
    return {
      level: 'brain',
      brainId: brain.id,
      organization: brain.organization,
      project: brain.project,
    };
  const task = taskOf(r, ctx);
  if (task) return forTask(task.t, task.repo, ctx);
  const cwd = r.cwd;
  if (!cwd) return { level: 'none' };
  let repo: { r: RepoCtx; len: number } | null = null;
  for (const x of ctx.repos)
    for (const p of x.paths)
      if (isInside(p, cwd) && (!repo || p.length > repo.len))
        repo = { r: x, len: p.length };
  if (repo)
    return {
      level: 'repo',
      organization: repo.r.organization,
      project: repo.r.project,
      repo: repo.r.name,
    };
  return { level: 'none' };
}

/** Whether `next` may replace the stored attribution `prev`: only a higher level, or a repo that got its connection. Task and brain level are frozen. */
export function raises(prev: Attribution, next: Attribution): boolean {
  if (prev.level === 'task' || prev.level === 'brain') return false;
  if (LEVEL_RANK[next.level] > LEVEL_RANK[prev.level]) return true;
  return (
    prev.level === 'repo' &&
    next.level === 'repo' &&
    prev.organization === null &&
    next.organization !== null
  );
}

/**
 * The stored version and a new one of the same request: attribution never goes down (and is frozen at task or brain), the
 * larger token copy wins, billable is the new one's. An unpriced stored copy takes the new copy's price when the
 * tokens are the same (a Shellie update brought a rate for its model).
 */
export function merge(
  prev: CostRecord | undefined,
  next: CostRecord,
): CostRecord {
  if (!prev) return next;
  const body = tokensOf(next) > tokensOf(prev) ? next : prev;
  const price =
    body === prev &&
    prev.costEur === null &&
    next.costEur !== null &&
    tokensOf(next) === tokensOf(prev)
      ? {
          costUsd: next.costUsd,
          costEur: next.costEur,
          rateId: next.rateId,
          modelLabel: next.modelLabel,
        }
      : {};
  return {
    ...body,
    ...price,
    attribution: raises(prev.attribution, next.attribution)
      ? next.attribution
      : prev.attribution,
    billable: next.billable,
    developer: next.developer ?? prev.developer,
  };
}
