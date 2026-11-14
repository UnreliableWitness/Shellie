import type { Turn } from '../brain/sessionDigest';
import { PR_SHAPE } from '../services/prSummary';

/**
 * How Shellie asks a task's agent tab for the PR description and reads the answer: one typed line that points to a
 * request file, and a reply with the description between two marker lines.
 */

export const PR_REQUEST_PREFIX =
  'Shellie: write the pull request description as asked in ';
export const PR_MARK_OPEN = '<!-- shellie-pr -->';
export const PR_MARK_CLOSE = '<!-- /shellie-pr -->';

const isAgent = (t: Turn) => t.who !== 'Developer';
export const isPrRequest = (t: Turn): boolean =>
  t.who === 'Developer' && t.text.startsWith(PR_REQUEST_PREFIX);

/** The line Shellie types into the tab, for a request file at `requestPath` (relative to the tab's folder). */
export const prRequestLine = (requestPath: string): string =>
  `${PR_REQUEST_PREFIX}${requestPath}`;

/**
 * The turns without Shellie's own requests: each request line and the agent's answer to it (its turns up to the next
 * thing the developer typed), so they never show up in a lessons digest or a "what was done".
 */
export function withoutPrRequests<T extends Turn>(turns: readonly T[]): T[] {
  const out: T[] = [];
  let skipping = false;
  for (const t of turns) {
    if (isPrRequest(t)) {
      skipping = true;
      continue;
    }
    if (skipping && isAgent(t)) continue;
    skipping = false;
    out.push(t);
  }
  return out;
}

/** The text between the markers in `text`; null when they are not both there or nothing is between them. */
export function betweenMarks(text: string): string | null {
  const open = text.indexOf(PR_MARK_OPEN);
  if (open < 0) return null;
  const close = text.indexOf(PR_MARK_CLOSE, open + PR_MARK_OPEN.length);
  if (close < 0) return null;
  const inner = text.slice(open + PR_MARK_OPEN.length, close).trim();
  return inner || null;
}

/**
 * What the session answered to the request typed as `line`: `reply` (the marked text) once an agent turn after the
 * line has it; `unmarked` when the agent answered after the line without it (asked something, refused); `pending`
 * when the line is not in the session yet, or nothing came after it.
 */
export function readReply(
  turns: readonly Turn[],
  line: string,
):
  | { kind: 'reply'; text: string }
  | { kind: 'unmarked' }
  | { kind: 'pending' } {
  let i = -1;
  for (let k = turns.length - 1; k >= 0; k--)
    if (turns[k].who === 'Developer' && turns[k].text.trim() === line) {
      i = k;
      break;
    }
  if (i < 0) return { kind: 'pending' };
  let answered = false;
  for (const t of turns.slice(i + 1)) {
    if (!isAgent(t)) break;
    answered = true;
    const text = betweenMarks(t.text);
    if (text) return { kind: 'reply', text };
  }
  return answered ? { kind: 'unmarked' } : { kind: 'pending' };
}

/** What the request file asks of the tab: the PR it is for, the shape and rules, and how to answer. */
export function prRequestText(o: {
  repo: string;
  branch: string;
  base: string | null;
  worktree: string;
  style: string | null;
}): string {
  return [
    '# Pull request description',
    '',
    `Shellie is opening a pull request for the work in this session and asks you for its description.`,
    '',
    `- Repo: ${o.repo}`,
    `- Branch: ${o.branch}${o.base ? ` (into ${o.base})` : ''}`,
    `- Worktree: ${o.worktree}`,
    '',
    'Write it from what you know of this task: what was asked, how you solved it and why that way, and what you checked. Answer from the session; read a file only when you must.',
    '',
    PR_SHAPE,
    ...(o.style?.trim()
      ? [
          '',
          "The repo's own style guide for descriptions (it wins over the shape above):",
          o.style.trim(),
        ]
      : []),
    '',
    'Do not edit, create or commit any file, and do not run anything that changes the repo.',
    `Reply with the description only, between a line ${PR_MARK_OPEN} and a line ${PR_MARK_CLOSE}.`,
    '',
  ].join('\n');
}
