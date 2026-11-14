/**
 * A compact digest of a task's Claude Code and OpenCode sessions for the brain's /lessons skill: what the developer
 * typed and what the agent answered, tool calls and their output left out. Markdown, bounded in size.
 */

import { clip } from '../../shared/text';

/** The whole digest, and one turn, are cut at these many characters. */
export const DIGEST_MAX = 60_000;
export const TURN_MAX = 2_000;

type Part = { type?: unknown; text?: unknown };
/** One turn of a session: Claude Code's agent speaks as Claude, OpenCode's as Agent. */
export type Turn = { who: 'Developer' | 'Claude' | 'Agent'; text: string };
type Line = {
  type?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isSidechain?: boolean;
  timestamp?: unknown;
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

/** One transcript line's turn, with when it was said (`timestamp`, epoch ms); null for anything that is not one. */
export function lineTurn(
  raw: string,
): (Turn & { at: number | null }) | null {
  let l: Line;
  try {
    l = JSON.parse(raw) as Line;
  } catch {
    return null;
  }
  if (!l || typeof l !== 'object') return null;
  if (l.isMeta || l.isSidechain || l.isCompactSummary) return null;
  if (l.type !== 'user' && l.type !== 'assistant') return null;
  const text = textOf(l.message?.content).trim();
  if (!text || MACHINE.test(text)) return null;
  const at = typeof l.timestamp === 'string' ? Date.parse(l.timestamp) : NaN;
  return {
    who: l.type === 'user' ? 'Developer' : 'Claude',
    text,
    at: Number.isFinite(at) ? at : null,
  };
}

/** The developer's and Claude's turns of one transcript (the jsonl lines), in order. */
export function sessionTurns(lines: string[]): Turn[] {
  const out: Turn[] = [];
  for (const raw of lines) {
    const t = lineTurn(raw);
    if (!t) continue;
    // Consecutive Claude turns (text between tool calls) read as one.
    const last = out[out.length - 1];
    if (last && last.who === t.who && t.who === 'Claude')
      last.text = `${last.text}\n${t.text}`;
    else out.push({ who: t.who, text: t.text });
  }
  return out;
}

/**
 * The markdown digest of a task's sessions, already read as turns (Claude Code's with `sessionTurns`, OpenCode's from
 * its database), in the order given; `null` when nobody typed anything (a task whose agent was never used).
 */
export function sessionDigest(
  title: string,
  sessions: readonly (readonly Turn[])[],
): string | null {
  const parts: string[] = [`# Session of task: ${title}`, ''];
  let any = false;
  let size = parts.join('\n').length;
  // Only sessions where a person typed count, and they are numbered among themselves.
  const used = sessions.filter((turns) =>
    turns.some((t) => t.who === 'Developer'),
  );
  for (const [i, turns] of used.entries()) {
    any = true;
    if (used.length > 1) parts.push(`## Session ${i + 1}`, '');
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
