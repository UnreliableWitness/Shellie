/**
 * A compact digest of a task's Claude Code sessions for the brain's /lessons skill: what the developer typed and
 * what Claude answered, tool calls and their output left out. Markdown, bounded in size.
 */

/** The whole digest, and one turn, are cut at these many characters. */
export const DIGEST_MAX = 60_000;
export const TURN_MAX = 2_000;

type Part = { type?: unknown; text?: unknown };
type Line = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: unknown };
};

/** Text Shellie or Claude Code injected, not something a person typed or Claude said. */
const MACHINE = /^(<[a-z-]+[\s>]|\[Request interrupted)/i;

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (p): p is { type: 'text'; text: string } =>
        typeof p === 'object' &&
        p !== null &&
        (p as Part).type === 'text' &&
        typeof (p as Part).text === 'string',
    )
    .map((p) => p.text)
    .join('\n');
};

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

/** The developer's and Claude's turns of one transcript (the jsonl lines), in order. */
export function sessionTurns(
  lines: string[],
): { who: 'Developer' | 'Claude'; text: string }[] {
  const out: { who: 'Developer' | 'Claude'; text: string }[] = [];
  for (const raw of lines) {
    let l: Line;
    try {
      l = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    if (l.isMeta || l.isSidechain) continue;
    if (l.type !== 'user' && l.type !== 'assistant') continue;
    const text = textOf(l.message?.content).trim();
    if (!text || MACHINE.test(text)) continue;
    const who = l.type === 'user' ? 'Developer' : 'Claude';
    // Consecutive Claude turns (text between tool calls) read as one.
    const last = out[out.length - 1];
    if (last && last.who === who && who === 'Claude')
      last.text = `${last.text}\n${text}`;
    else out.push({ who, text });
  }
  return out;
}

/**
 * The markdown digest of a task's sessions, oldest session first. `null` when there is nothing a person typed
 * (a task whose Claude was never used).
 */
export function sessionDigest(
  title: string,
  sessions: string[][],
): string | null {
  const parts: string[] = [`# Session of task: ${title}`, ''];
  let any = false;
  let size = parts.join('\n').length;
  for (const [i, lines] of sessions.entries()) {
    const turns = sessionTurns(lines);
    if (!turns.some((t) => t.who === 'Developer')) continue;
    any = true;
    if (sessions.length > 1) parts.push(`## Session ${i + 1}`, '');
    for (const t of turns) {
      const block = `**${t.who}:** ${clip(t.text.replace(/\r\n/g, '\n'), TURN_MAX)}\n`;
      if (size + block.length > DIGEST_MAX) {
        parts.push('_(cut: the sessions were longer)_', '');
        return parts.join('\n');
      }
      parts.push(block);
      size += block.length + 1;
    }
  }
  return any ? parts.join('\n') : null;
}
