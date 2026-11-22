/**
 * Dreams as the app runs them: the store loaded, the runner on the pty host, the limit from OpenCode's database, and
 * the scheduler, swept once before its first check. `src/main.ts` passes the app's own pieces.
 */

import fs from 'node:fs/promises';
import type { AttentionState } from '../../shared/attention';
import {
  dreamingOf,
  projectsOnModel,
  pruneDreaming,
  splitLegacyDreaming,
} from '../../shared/dreams';
import type { Repo, Task } from '../../shared/types';
import type { OpenCodeReader } from '../budget/openCode';
import type { TurnAt } from '../sessions/claudeTranscript';
import { targetBranch } from '../services/azureRepos';
import {
  claudeSessionTurns,
  opencodeDirs,
  opencodeSessionTurns,
} from '../sessions/taskSessions';
import { DreamRunner, type DreamRunnerDeps } from './DreamRunner';
import type { DreamStore } from './DreamStore';
import type { limitChecks } from './limit';
import type { TaskSessions } from './material';
import { startDreamScheduler, type DreamSchedulerDeps } from './scheduler';

const AGENTS = ['claude', 'opencode'] as const;
/** The tabs that use the owner's agent licences. */
const AGENT_TABS = new Set(['claude', 'opencode', 'copilot']);

/**
 * Some open task's agent tab last reported `working`. Only agent tabs of tasks count: every tab gets the attention
 * route in its environment (src/main.ts `terminalEnv`), so a shell could post a state too, and the brain terminal
 * is no task's. Brain jobs and PR descriptions run headless and have no tab.
 */
export function taskAgentWorking(
  tasks: Task[],
  state: (terminalId: string) => AttentionState | null,
): boolean {
  return tasks.some((t) =>
    t.terminals.some(
      (x) => AGENT_TABS.has(x.kind) && state(x.id) === 'working',
    ),
  );
}

type SessionReads = {
  sessionFile: (sessionId: string) => string | null;
  /** OpenCode's turns with their times (epoch ms), as Claude's carry them. */
  opencodeSessionTurns: (dirs: readonly string[], since: number) => TurnAt[][];
  /** When the task's OpenCode session updated last changed (epoch ms); null when it has none. */
  opencodeUpdatedAt?: (dirs: readonly string[], since: number) => number | null;
};

/**
 * Whether something of the task's sessions may have been said after `mark` (epoch ms): a Claude transcript written
 * after it, or an OpenCode session updated after it. Only a prefilter (`pickMaterial` decides), so any doubt (a file
 * that cannot be stat'ed, OpenCode's time unknown) says yes.
 */
async function changedAfter(
  t: Task,
  mark: number,
  read: SessionReads,
): Promise<boolean> {
  const tabs = [...t.closedTerminals, ...t.terminals];
  for (const x of tabs) {
    if (x.kind !== 'claude' || !x.sessionId) continue;
    const file = read.sessionFile(x.sessionId);
    if (!file) continue;
    const st = await fs.stat(file).catch(() => null);
    if (!st || st.mtimeMs > mark) return true;
  }
  if (!tabs.some((x) => x.kind === 'opencode')) return false;
  if (!read.opencodeUpdatedAt) return true;
  try {
    const at = read.opencodeUpdatedAt(
      opencodeDirs(t),
      Date.parse(t.createdAt) || 0,
    );
    return at !== null && at > mark;
  } catch {
    return true;
  }
}

/**
 * What was said in each stored task (open and finished) whose home is the repo. With `covered` (the repo's marks), a
 * task whose sessions did not change after its mark is left out unread: it would hold no new material.
 */
export async function dreamSessionsOf(
  tasks: Task[],
  repoId: string,
  read: SessionReads,
  covered?: Record<string, number>,
): Promise<TaskSessions[]> {
  const out: TaskSessions[] = [];
  for (const t of tasks) {
    if (t.repoId !== repoId) continue;
    const mark = covered?.[t.id];
    if (mark !== undefined && !(await changedAfter(t, mark, read))) continue;
    const tabs = [...t.closedTerminals, ...t.terminals];
    const id = Number(t.workItem?.id);
    out.push({
      taskId: t.id,
      label: t.workItem?.title ?? t.name,
      workItemId: Number.isInteger(id) ? id : null,
      createdAt: t.createdAt,
      agents: AGENTS.filter((a) => tabs.some((x) => x.kind === a)),
      sessions: [
        ...(await claudeSessionTurns(t, read.sessionFile)),
        ...opencodeSessionTurns(
          t,
          read.opencodeSessionTurns,
          '[dreams] OpenCode sessions not read',
        ),
      ],
    });
  }
  return out;
}

/**
 * The repos with a task added, removed or changed since `seen` (each task as JSON, with its repo, by id), which is
 * brought up to date. A task moved to another repo counts for both.
 */
export function changedTaskRepos(
  seen: Map<string, { repoId: string | null; json: string }>,
  tasks: Task[],
): Set<string> {
  const repos = new Set<string>();
  const add = (id: string | null) => {
    if (id !== null) repos.add(id);
  };
  const ids = new Set<string>();
  for (const t of tasks) {
    ids.add(t.id);
    const json = JSON.stringify(t);
    const was = seen.get(t.id);
    if (was?.json === json) continue;
    add(t.repoId);
    if (was) add(was.repoId);
    seen.set(t.id, { repoId: t.repoId, json });
  }
  for (const [id, was] of seen)
    if (!ids.has(id)) {
      add(was.repoId);
      seen.delete(id);
    }
  return repos;
}

/**
 * Dreams of before 2026-11-21 had one setup for the whole app: it becomes one per project, once, here, where the
 * repos (and so their projects) are known. No project is switched on that had no repo switched on. Then the old
 * switch-off record goes to the project of its repo (to every project on its model when it names none), and repos
 * that are no longer their block's project's leave it.
 */
export async function toProjects(
  settings: Pick<DreamSchedulerDeps['settings'], 'get' | 'updateDreaming'>,
  store: Pick<DreamStore, 'adoptLegacySwitchedOff'>,
  repos: { id: string; connectionId: string | null }[],
): Promise<void> {
  const legacy = settings.get().dreaming.legacy;
  // With no repo known (a repo list that did not load) the old setup is kept for the next start, not lost.
  const waits =
    legacy !== null &&
    repos.length === 0 &&
    Object.keys(legacy.repos).length > 0;
  if (!waits)
    await settings.updateDreaming((cur) =>
      pruneDreaming(
        {
          projects: {
            ...(cur.legacy ? splitLegacyDreaming(cur.legacy, repos) : {}),
            // A project set up since wins over the copy.
            ...cur.projects,
          },
          legacy: null,
        },
        repos,
      ),
    );
  // While the old setup waits, its switch-off record waits with it (it keeps every project off meanwhile).
  if (waits) return;
  await store.adoptLegacySwitchedOff((record) => {
    const home = repos.find((r) => r.id === record.repoId)?.connectionId;
    if (home) return [home];
    return projectsOnModel(settings.get().dreaming, record.chosen);
  });
}

export async function startDreams(
  d: Pick<
    DreamSchedulerDeps,
    | 'settings'
    | 'models'
    | 'idleSeconds'
    | 'onBattery'
    | 'agentWorking'
    | 'broadcast'
    | 'dreamsDir'
    | 'event'
  > &
    Pick<DreamRunnerDeps, 'git' | 'platform' | 'run'> & {
      store: DreamStore;
      reader: Pick<
        OpenCodeReader,
        'sessionModels' | 'sessionTurns' | 'latestSession'
      >;
      /** The day's limit, the one `dream:get` shows the usage of. */
      limit: ReturnType<typeof limitChecks>;
      tasks: () => Task[];
      repos: () => Repo[];
      sessionFile: (sessionId: string) => string | null;
      /** The repo's configured base (`origin/main`), as a new task starts from it. */
      configBase: (repoPath: string) => Promise<string>;
    },
) {
  await d.store.load();
  await toProjects(d.settings, d.store, d.repos()).catch((e: unknown) =>
    console.error('[dreams] the dream settings were not moved to projects', e),
  );
  const now = Date.now;
  const checks = d.limit;
  const sessionsOf = (repoId: string, covered?: Record<string, number>) =>
    dreamSessionsOf(
      d.tasks(),
      repoId,
      {
        sessionFile: d.sessionFile,
        opencodeSessionTurns: (dirs, since) =>
          d.reader.sessionTurns(dirs, since),
        opencodeUpdatedAt: (dirs, since) =>
          d.reader.latestSession(dirs, since)?.updatedAt ?? null,
      },
      covered,
    );
  const runner: DreamRunner = new DreamRunner({
    git: d.git,
    platform: d.platform,
    run: d.run,
    store: d.store,
    dreamsDir: d.dreamsDir,
    sessionsOf,
    sessionModels: (id) => d.reader.sessionModels(id),
    dreamTokens: (since, until) =>
      checks.tokens(runner.running()?.project ?? '', since, until),
    // The PR target, as a task's pull request resolves it from its base.
    baseBranch: async (repo) =>
      targetBranch(
        await d.configBase(repo.path),
        await d.git.remotes(repo.path).catch(() => []),
      ),
    now,
    overLimit: () => {
      const r = runner.running();
      return checks.overLimitFor(r?.project ?? '', r?.startedAt ?? now());
    },
    folders: (repoId) => {
      const project = d.repos().find((x) => x.id === repoId)?.connectionId;
      if (!project) return [];
      const r = dreamingOf(d.settings.get().dreaming, project).repos[repoId];
      return r?.on ? r.folders : [];
    },
  });
  const scheduler = startDreamScheduler({
    ...d,
    store: d.store,
    runner,
    repos: () =>
      d.repos().map(({ id, name, path, connectionId }) => ({
        id,
        name,
        path,
        connectionId,
      })),
    sessionsOf,
    limit: checks,
    now,
  });
  // Queued before the first check.
  void scheduler
    .sweep()
    .catch((e: unknown) => console.error('[dreams] sweep failed', e));
  return scheduler;
}
