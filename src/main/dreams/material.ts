/**
 * The session material of a dream: which tasks have developer turns the dream has not covered yet, and the digest
 * files its agent reads. Session text is customer material: it is written only into the folder given, never logged.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DreamRepoState } from '../../shared/dreams';
import { sessionDigest } from '../brain/sessionDigest';
import type { TurnAt } from '../sessions/claudeTranscript';

export type TaskSessions = {
  taskId: string;
  label: string;
  workItemId: number | null;
  createdAt: string;
  agents: ('claude' | 'opencode')[];
  sessions: TurnAt[][];
};
export type Material = {
  tasks: (TaskSessions & { newSince: number | null })[];
  marks: Record<string, number>;
};

export const MAX_DREAM_TASKS = 20;

const at = (t: TurnAt): number => t.at ?? 0;

/** The time of the latest turn of the given kind across the sessions, or null when there is none. */
const latest = (
  sessions: TurnAt[][],
  developerOnly: boolean,
): number | null => {
  let best: number | null = null;
  for (const s of sessions)
    for (const t of s) {
      if (developerOnly && t.who !== 'Developer') continue;
      if (best === null || at(t) > best) best = at(t);
    }
  return best;
};

/** Tasks with a developer turn after their covered mark, newest activity first, at most 20. */
export function pickMaterial(
  all: TaskSessions[],
  covered: Record<string, number>,
): Material {
  const picked: { t: TaskSessions; last: number }[] = [];
  for (const t of all) {
    const lastDev = latest(t.sessions, true);
    if (lastDev === null) continue;
    const mark = covered[t.taskId];
    if (mark !== undefined && lastDev <= mark) continue;
    picked.push({ t, last: latest(t.sessions, false) ?? lastDev });
  }
  picked.sort((a, b) => b.last - a.last);
  const top = picked.slice(0, MAX_DREAM_TASKS);
  const marks: Record<string, number> = {};
  for (const p of top) marks[p.t.taskId] = p.last;
  return {
    tasks: top.map((p) => ({
      ...p.t,
      newSince: covered[p.t.taskId] ?? null,
    })),
    marks,
  };
}

/** A file name from letters, digits, `-` and `_`; ids that needed changing get a hash so two never collide. */
function fileNames(ids: string[]): string[] {
  const used = new Set<string>();
  return ids.map((id) => {
    const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
    let name =
      safe === id && safe !== ''
        ? safe
        : `${safe}_${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
    for (let n = 2; used.has(name); n++) name = `${safe}_${n}`;
    used.add(name);
    return `tasks/${name}.md`;
  });
}

const day = (iso: string): string => iso.slice(0, 10);

/** Writes `index.md` and `tasks/<taskId>.md` into `dir`; returns the file names. */
export async function writeMaterial(
  dir: string,
  m: Material,
  memory: Pick<DreamRepoState, 'sightings' | 'rejections'>,
): Promise<string[]> {
  await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
  const names = fileNames(m.tasks.map((t) => t.taskId));
  const lines: string[] = ['# Sessions to read', ''];
  for (const [i, t] of m.tasks.entries()) {
    const body =
      sessionDigest(t.label, t.sessions) ?? `# Session of task: ${t.label}\n`;
    await fs.writeFile(path.join(dir, names[i]), body, 'utf8');
    lines.push(
      `- ${t.label} (${names[i]}): work item ${t.workItemId ?? 'none'}, created ${day(t.createdAt)}, ` +
        `agents ${t.agents.join(', ')}, ` +
        (t.newSince === null
          ? 'not seen before'
          : `new since ${new Date(t.newSince).toISOString()}`),
    );
  }
  lines.push('');
  if (memory.sightings.length) {
    lines.push('## Seen once before', '');
    for (const s of memory.sightings)
      lines.push(`- ${day(s.at)} (task ${s.taskId}): ${s.note} "${s.quote}"`);
    lines.push('');
  }
  if (memory.rejections.length) {
    lines.push('## Rejected before', '');
    for (const r of memory.rejections)
      lines.push(`- ${day(r.at)} ${r.title}: ${r.why}`);
    lines.push('');
  }
  await fs.writeFile(path.join(dir, 'index.md'), lines.join('\n'), 'utf8');
  return ['index.md', ...names];
}
