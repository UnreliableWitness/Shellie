import type { Command } from './types';

/**
 * How well `title` answers `query` (both lower case): null when the query's letters are not in it in order.
 * A lower score is better: the query as one piece scores its position, scattered letters score past every such
 * match, by how far they spread.
 */
function score(query: string, title: string): number | null {
  const at = title.indexOf(query);
  if (at >= 0) return at;
  let from = 0;
  let first = -1;
  for (const ch of query) {
    const i = title.indexOf(ch, from);
    if (i < 0) return null;
    if (first < 0) first = i;
    from = i + 1;
  }
  return 1000 + (from - first);
}

/**
 * The commands a query asks for, best first; an empty query gives them as they are. A title matches when it holds
 * the query's letters in order, whatever their case. Ties keep the given order.
 */
export function rank(query: string, commands: Command[]): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands
    .map((command, i) => ({
      command,
      i,
      s: score(q, command.title.toLowerCase()),
    }))
    .filter(
      (x): x is { command: Command; i: number; s: number } => x.s !== null,
    )
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.command);
}
