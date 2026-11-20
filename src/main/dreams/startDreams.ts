/**
 * Dreams as the app runs them: the store loaded, the runner on the pty host, the limit from OpenCode's database, and
 * the scheduler, swept once before its first check. `src/main.ts` passes the app's own pieces.
 */

import type { AttentionState } from '../../shared/attention';
import type { Repo, Task } from '../../shared/types';
import type { OpenCodeReader } from '../budget/openCode';
import type { TurnAt } from '../sessions/claudeTranscript';
import { targetBranch } from '../services/azureRepos';
import {
  claudeSessionTurns,
  opencodeSessionTurns,
} from '../sessions/taskSessions';
import { DreamRunner, type DreamRunnerDeps } from './DreamRunner';
import type { DreamStore } from './DreamStore';
import { limitChecks } from './limit';
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

/** What was said in each stored task (open and finished) whose home is the repo. */
export async function dreamSessionsOf(
  tasks: Task[],
  repoId: string,
  read: {
    sessionFile: (sessionId: string) => string | null;
    /** OpenCode's turns with their times (epoch ms), as Claude's carry them. */
    opencodeSessionTurns: (
      dirs: readonly string[],
      since: number,
    ) => TurnAt[][];
  },
): Promise<TaskSessions[]> {
  const out: TaskSessions[] = [];
  for (const t of tasks) {
    if (t.repoId !== repoId) continue;
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
        'sessionModels' | 'dreamTokens' | 'sessionTurns'
      >;
      tasks: () => Task[];
      repos: () => Repo[];
      sessionFile: (sessionId: string) => string | null;
      /** The repo's configured base (`origin/main`), as a new task starts from it. */
      configBase: (repoPath: string) => Promise<string>;
    },
) {
  await d.store.load();
  const now = Date.now;
  const checks = limitChecks({
    reader: d.reader,
    limit: () => d.settings.get().dreaming.limit,
    now,
  });
  const sessionsOf = (repoId: string) =>
    dreamSessionsOf(d.tasks(), repoId, {
      sessionFile: d.sessionFile,
      opencodeSessionTurns: (dirs, since) => d.reader.sessionTurns(dirs, since),
    });
  const runner: DreamRunner = new DreamRunner({
    git: d.git,
    platform: d.platform,
    run: d.run,
    store: d.store,
    dreamsDir: d.dreamsDir,
    sessionsOf,
    sessionModels: (id) => d.reader.sessionModels(id),
    dreamTokens: checks.tokens,
    // The PR target, as a task's pull request resolves it from its base.
    baseBranch: async (repo) =>
      targetBranch(
        await d.configBase(repo.path),
        await d.git.remotes(repo.path).catch(() => []),
      ),
    now,
    overLimit: () =>
      checks.overLimitFor(runner.running()?.startedAt ?? now())(),
  });
  const scheduler = startDreamScheduler({
    ...d,
    store: d.store,
    runner,
    repos: () => d.repos().map(({ id, name, path }) => ({ id, name, path })),
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
