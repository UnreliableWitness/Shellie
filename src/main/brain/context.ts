import fs from 'node:fs/promises';
import path from 'node:path';
import type { Brain } from '../../shared/brain';
import type { GitClient } from '../services/GitClient';
import type { BrainStore } from './BrainStore';

/** How much of the brain's index.md a task's task.md gets. */
export const CONTEXT_MAX_LINES = 150;

/** The "Context" section of task.md: where the brain is, and its index (cut at CONTEXT_MAX_LINES lines). */
export function contextSection(
  brainName: string,
  brainPath: string,
  indexMd: string,
): string {
  const lines = indexMd.replace(/\s+$/, '').split(/\r?\n/);
  const kept = lines.slice(0, CONTEXT_MAX_LINES);
  const more = lines.length - kept.length;
  return [
    `## Context: ${brainName}`,
    `The project's brain is at ${brainPath}. Read-only for this task: read pages, do not edit them.`,
    '',
    ...kept,
    ...(more > 0 ? ['', `… ${more} more in index.md`] : []),
    '',
  ].join('\n');
}

/** Appends the section to task.md, after a blank line. */
export async function appendContext(
  taskMdPath: string,
  section: string,
): Promise<void> {
  await fs.appendFile(taskMdPath, '\n' + section, 'utf8');
}

/** The log.md line a finished task leaves in its project's brain. */
export function closeLine(
  now: Date,
  workItemId: string | null,
  title: string,
  link: string,
): string {
  const what = workItemId ? `task #${workItemId} closed` : 'task closed';
  return `- ${now.toISOString()} ${what}: ${title} (${link})`;
}

/** Puts the line at the top of log.md's entries (right after the `# Log` heading, newest first) and commits it. */
export async function appendLog(
  git: GitClient,
  brainDir: string,
  line: string,
): Promise<void> {
  const file = path.join(brainDir, 'log.md');
  const text = await fs.readFile(file, 'utf8').catch(() => '# Log\n\n');
  const lines = text.split('\n');
  let at = lines.findIndex((l) => l.trim() === '# Log');
  if (at < 0) {
    lines.unshift('# Log', '');
    at = 0;
  }
  // Keep the blank line under the heading.
  const insert = lines[at + 1] === '' ? at + 2 : at + 1;
  lines.splice(insert, 0, line);
  await fs.writeFile(file, lines.join('\n'), 'utf8');
  await git.run(brainDir, ['add', '--', 'log.md']);
  await git.run(brainDir, [
    'commit',
    '-q',
    '-m',
    'Brain: task closed',
    '--',
    'log.md',
  ]);
}

/** The brain of a task's connection and project; the first when there are several. */
export function brainForTask(
  brains: BrainStore,
  connectionId: string | null,
  project: string | null,
): Brain | null {
  if (!connectionId || !project) return null;
  return brains.forProject(connectionId, project)[0] ?? null;
}
