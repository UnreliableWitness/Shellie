/** Asking a brain from a task: the shapes main and the renderer share, and the helpers that need no I/O. */

/** The questions the task's Brain tab offers; "this" is the task's work item (askWithContext). */
export const ASK_SUGGESTIONS = [
  'What should I know before I start on this?',
  'What has been decided that affects this?',
  'Who knows most about this?',
] as const;

/** A question reads a handful of pages: far less than a job's ten minutes. */
export const ASK_TIMEOUT_MS = 180_000;

export type AskContext = { workItemId: string | null; title: string };

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The question on one line, then what "this" means: the task's work item, else the task. */
export function askWithContext(question: string, c: AskContext): string {
  const title = oneLine(c.title);
  const about = c.workItemId
    ? `(Asked from the task for work item ${c.workItemId}: ${title}.)`
    : `(Asked from the task "${title}".)`;
  return `${oneLine(question)} ${about}`;
}

const CITED = /(?:^|[\s`([\]"'])((?:wiki|sources)\/[^\s`()[\]"'#]+?\.md)/g;

/** The `wiki/…` and `sources/…` paths an answer names, without anchor, in the order first named, each once. */
export function citedPaths(answer: string): string[] {
  const found: string[] = [];
  for (const m of answer.matchAll(CITED)) {
    const p = m[1];
    if (p.split('/').includes('..') || found.includes(p)) continue;
    found.push(p);
  }
  return found;
}

const LINKABLE =
  /(^|[\s`([\]"'])((?:wiki|sources)\/[^\s`()[\]"'#]+?\.md)(#[\w-]+(?:\.[\w-]+)*)?(`?)/gm;
const FENCE = /^(```|~~~)/;

/**
 * The answer with every cited path that `exists` made a Markdown link (with its anchor), so the page opens from the
 * answer. A path that does not exist, leaves the brain, sits in a fenced code block, or already is a link's text or
 * target stays as written.
 */
export function linkCited(
  answer: string,
  exists: (path: string) => boolean,
): string {
  const link = (text: string) =>
    text.replace(
      LINKABLE,
      (
        whole: string,
        before: string,
        p: string,
        anchor = '',
        tick: string,
        at: number,
      ) => {
        if (p.split('/').includes('..') || !exists(p)) return whole;
        // `](wiki/a.md)` and `]( wiki/a.md)`: the target of a link the agent wrote itself.
        if (/\]\(\s*$/.test(text.slice(0, at + before.length))) return whole;
        // `[wiki/a.md](…)`: its text.
        if (before === '[' && text.slice(at + whole.length).startsWith(']('))
          return whole;
        const ticked = before === '`' && tick === '`';
        const target = `${p}${anchor}`;
        return `${ticked ? '' : before}[${target}](${target})${ticked ? '' : tick}`;
      },
    );
  // Line by line outside fenced code: a path in a code block is shown as written.
  let fenced = false;
  return answer
    .split('\n')
    .map((line) => {
      if (FENCE.test(line.trimStart())) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : link(line);
    })
    .join('\n');
}

export type BrainAnswer = {
  /** The agent's session, to follow up on or to continue in the brain terminal; null when the run named none. */
  sessionId: string | null;
  /** Markdown. */
  answer: string;
  durationMs: number;
  /** What the run cost; null while the ledger has no record of it. */
  costEur: number | null;
  /**
   * The brain's folder is not as it was before the question (or that could not be told). A question cannot write,
   * so this is a job or a person at work at the same moment, or a hole worth knowing about.
   */
  changed: boolean;
};

/** Why a question was not run: the brain's daily token cap, or its jobs being held. */
export type AskRefusal = 'cap' | 'held';

export type AskOutcome =
  | { ok: true; answer: BrainAnswer }
  /** `refused` null: the run failed, timed out or was stopped (`stopped`: by the person). */
  | {
      ok: false;
      refused: AskRefusal | null;
      message: string;
      stopped?: true;
    };

export const ASK_CAP_MESSAGE =
  "The brain reached today's limit. Open the brain's terminal to ask anyway, or raise the limit in Settings.";

export const ASK_STOPPED = 'Stopped';
