import type { Task, WorkItemDetails, WorkItemRef } from './types';
import { taskWorkspaces } from './workspaces';

export function slugify(text: string, max = 40): string {
  const base = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = base.slice(0, max).replace(/-+$/g, '');
  return cut || 'task';
}

export function branchType(workItem: WorkItemRef | null): 'feature' | 'bugfix' {
  return workItem?.type === 'Bug' ? 'bugfix' : 'feature';
}

export function renderBranch(
  template: string,
  input: { workItem: WorkItemRef | null; name: string },
): string {
  const slug = slugify(input.workItem?.title ?? input.name);
  let out = template
    .replaceAll('{type}', branchType(input.workItem))
    .replaceAll('{slug}', slug);
  const id = input.workItem?.id ?? '';
  out = id
    ? out.replaceAll('{id}', id)
    : out.replaceAll('{id}-', '').replaceAll('{id}', '');
  return out;
}

export function taskSlug(workItem: WorkItemRef | null, name: string): string {
  return workItem ? `${workItem.id}-${slugify(workItem.title)}` : slugify(name);
}

export function taskTitle(task: Pick<Task, 'workItem' | 'name'>): string {
  return task.workItem
    ? `${task.workItem.type} ${task.workItem.id}: ${task.workItem.title}`
    : `Task: ${task.name}`;
}

/** Fields task.md shows by name, in this order. */
const HEADLINE_FIELDS: [string, string][] = [
  ['Title', 'System.Title'],
  ['Type', 'System.WorkItemType'],
  ['State', 'System.State'],
  ['Assigned to', 'System.AssignedTo'],
  ['Area', 'System.AreaPath'],
  ['Iteration', 'System.IterationPath'],
  ['Tags', 'System.Tags'],
];

/** Long text fields, each under its own heading. */
const TEXT_FIELDS: [string, string][] = [
  ['Description', 'System.Description'],
  ['Acceptance criteria', 'Microsoft.VSTS.Common.AcceptanceCriteria'],
  ['Repro steps', 'Microsoft.VSTS.TCM.ReproSteps'],
];

/** Bookkeeping fields that tell an agent nothing about the work; System.History repeats the last comment. */
const NOISE_FIELDS = new Set([
  'System.Id',
  'System.Rev',
  'System.Watermark',
  'System.AuthorizedAs',
  'System.AuthorizedDate',
  'System.RevisedDate',
  'System.PersonId',
  'System.AreaId',
  'System.IterationId',
  'System.NodeName',
  'System.History',
  'System.CommentCount',
  'System.AttachedFileCount',
  'System.ExternalLinkCount',
  'System.HyperLinkCount',
  'System.RelatedLinkCount',
  'System.RemoteLinkCount',
]);
const isNoise = (name: string) =>
  NOISE_FIELDS.has(name) ||
  /^System\.(Area|Iteration)Level\d+$/.test(name) ||
  name.startsWith('WEF_');

/** The work item part of task.md is cut to about this many characters, dropping the oldest comments first. */
export const WORK_ITEM_MAX_CHARS = 200_000;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Azure DevOps HTML (descriptions, HTML comments) as plain text: line breaks and list items kept, other tags dropped. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|ul|ol|h[1-6]|tr|table|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      const lower = e.toLowerCase();
      if (lower.startsWith('#x'))
        return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith('#'))
        return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[lower] ?? m;
    })
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const looksLikeHtml = (s: string) => /<\/?[a-z][^>]*>/i.test(s);

/** A field value as one line of text: identities by display name, HTML stripped; empty when there is nothing. */
function fieldText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string')
    return looksLikeHtml(value) ? htmlToText(value) : value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.displayName === 'string') return v.displayName;
    return JSON.stringify(value);
  }
  return String(value);
}

function workItemSection(
  details: WorkItemDetails,
  fallbackUrl: string | null,
): string {
  const f = details.fields;
  const url = details.url ?? fallbackUrl;
  const head = [
    '## Work item',
    '',
    ...HEADLINE_FIELDS.flatMap(([label, name]) => {
      const v = fieldText(f[name]);
      return v ? [`- ${label}: ${v}`] : [];
    }),
    ...(url ? [`- URL: ${url}`] : []),
    ...details.links.map((l) => `- ${l.name}: ${l.id}`),
    '',
    ...TEXT_FIELDS.flatMap(([label, name]) => {
      const v = fieldText(f[name]);
      return v ? [`### ${label}`, '', v, ''] : [];
    }),
  ];
  const shown = new Set([...HEADLINE_FIELDS, ...TEXT_FIELDS].map((p) => p[1]));
  const other = Object.keys(f)
    .filter((name) => !shown.has(name) && !isNoise(name))
    .sort()
    .flatMap((name) => {
      const v = fieldText(f[name]);
      return v ? [`- ${name}: ${v.replace(/\n+/g, ' ')}`] : [];
    });
  if (other.length > 0) head.push('### Other fields', '', ...other, '');
  let out = head.join('\n');
  if (out.length > WORK_ITEM_MAX_CHARS)
    return `${out.slice(0, WORK_ITEM_MAX_CHARS)}\n\n(The work item was cut here: it is too long for this file.)\n`;
  if (details.comments.length === 0) return out;
  // Newest first until the cap, then shown oldest first.
  const kept: string[] = [];
  let size = out.length;
  for (const c of [...details.comments].reverse()) {
    const text = c.html ? htmlToText(c.text) : c.text.trim();
    const block = `### ${c.author}, ${c.createdDate}\n\n${text}\n`;
    if (size + block.length > WORK_ITEM_MAX_CHARS) break;
    kept.push(block);
    size += block.length + 1;
  }
  const left = details.comments.length - kept.length;
  out += [
    '',
    '## Comments',
    '',
    ...(left > 0
      ? [`(${left} older comments left out: this file is capped in size.)`, '']
      : []),
    kept.reverse().join('\n'),
  ].join('\n');
  return out;
}

/** The task file; `details`, when Azure DevOps answered at setup, adds the whole work item and its comments. */
export function renderTaskMd(
  task: Task,
  repoPaths: Record<string, string> = {},
  details?: WorkItemDetails,
): string {
  const lines = [
    `# ${taskTitle(task)}`,
    '',
    `- Branch: \`${task.branch}\``,
    `- Base: \`${task.baseRef}\``,
    `- Worktree: \`${task.worktreePath}\``,
    `- Created: ${task.createdAt}`,
    '',
    ...(task.extraWorkspaces.length > 0
      ? [
          '## Workspaces',
          '',
          ...taskWorkspaces(task).map(
            (w) =>
              `- Repo \`${repoPaths[w.repoId] ?? w.repoId}\`: branch \`${w.branch}\`, worktree \`${w.worktreePath}\`${w.dropped ? ' (left out)' : ''}`,
          ),
          '',
        ]
      : []),
    otherReposInstruction(task),
    '',
    'This file is written by Shellie and excluded from git. Put notes for the task here.',
    '',
  ];
  const base = lines.join('\n');
  return details
    ? `${base}\n${workItemSection(details, task.workItem?.url ?? null)}`
    : base;
}

/** How Claude joins another repo to the task: a worktree on the task's branch, which Shellie detects. */
export function otherReposInstruction(
  task: Pick<Task, 'branch' | 'slug'>,
): string {
  return `If this task needs changes in another repository, do not edit that repository's main checkout. Create a worktree there on this task's branch: git -C <repo> worktree add <repo>.worktrees/${task.slug} -b ${task.branch} <base> (use the repo's default branch as base, from origin when it exists). Shellie picks it up automatically.`;
}

/**
 * Tells an agent which commands get the project's secrets (`shellie run`); `names` are the task's run names.
 * Only for a repo with stored secrets.
 */
export function shellieRunInstruction(names: string[]): string {
  return `Commands that need this project's secrets (tests, the dev server) run through \`shellie run <name>\`; available: ${names.join(', ')}. Plain commands in your shell run without secrets.`;
}

/**
 * Appended to Claude Code's system prompt: the task, and that Claude waits for the user before working on it.
 * `runNames`: the `shellie run` names, given only when the task's repo has a stored secret.
 */
export function claudeContext(
  task: Pick<Task, 'workItem' | 'name' | 'branch' | 'slug'>,
  runNames?: string[],
): string {
  const base = `This folder is a Shellie task for ${taskTitle(task)}. The details are in .shellie/task.md. Do not start on the task by yourself: wait for the user's instructions. ${otherReposInstruction(task)}`;
  return runNames && runNames.length > 0
    ? `${base} ${shellieRunInstruction(runNames)}`
    : base;
}
