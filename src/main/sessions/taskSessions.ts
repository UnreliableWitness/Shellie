/**
 * What was said in a task's agent sessions (Claude Code and OpenCode), for its lessons at Finish and for dreams.
 * Shellie's own PR-description requests and their answers are never part of it.
 */

import type { Task } from '../../shared/types';
import { taskWorkspaces } from '../../shared/workspaces';
import type { Turn } from '../brain/sessionDigest';
import { folderPaths } from '../paths';
import { withoutPrRequests } from '../prDraft/protocol';
import { readClaudeTurns, type TurnAt } from './claudeTranscript';

/**
 * What was said in the task's OpenCode sessions (in any of its worktrees, since it was created); none without an
 * OpenCode tab or without `texts`, and none when OpenCode's database cannot be read (logged, so the Claude lessons
 * still go in).
 */
export function opencodeSessionTurns(
  task: Task,
  texts: ((dirs: readonly string[], since: number) => Turn[][]) | undefined,
): Turn[][] {
  const tabs = [...task.closedTerminals, ...task.terminals];
  if (!texts || !tabs.some((t) => t.kind === 'opencode')) return [];
  const dirs = [
    ...new Set(
      taskWorkspaces(task).flatMap((w) => folderPaths(w.worktreePath)),
    ),
  ];
  try {
    return texts(dirs, Date.parse(task.createdAt) || 0).map((turns) =>
      withoutPrRequests(turns),
    );
  } catch (e) {
    console.error('[brain] OpenCode sessions not read for lessons', e);
    return [];
  }
}

/** The turns of the task's Claude Code sessions (open and closed tabs), each session's in order; unsaved ones are skipped. */
export async function claudeSessionTurns(
  task: Task,
  sessionFile: (sessionId: string) => string | null,
): Promise<TurnAt[][]> {
  const ids = [...task.closedTerminals, ...task.terminals]
    .filter((t) => t.kind === 'claude' && t.sessionId)
    .map((t) => t.sessionId!);
  const out: TurnAt[][] = [];
  for (const id of new Set(ids)) {
    const file = sessionFile(id);
    if (!file) continue;
    const { turns } = await readClaudeTurns(file);
    if (turns.length > 0) out.push(withoutPrRequests(turns));
  }
  return out;
}
