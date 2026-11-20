/** One line of a unified diff: kept (` `), removed (`-`) or added (`+`), numbered by its own side. */
export type DiffLine = { sign: ' ' | '-' | '+'; text: string; no: number };
export type DiffHunk = { lines: DiffLine[] };

/** Lines of context around a change. */
const CONTEXT = 3;
/** Above this many cells of the table the middle is shown as all removed, then all added. */
const MAX_CELLS = 4_000_000;

const linesOf = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** The middle of two texts as kept, removed and added lines: a longest common subsequence, bounded in size. */
function middle(a: string[], b: string[]): ('=' | '-' | '+')[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS)
    return [...a.map(() => '-' as const), ...b.map(() => '+' as const)];
  // lcs[i * (m + 1) + j]: the common subsequence of a[i..] and b[j..].
  const w = m + 1;
  const lcs = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const ops: ('=' | '-' | '+')[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('=');
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      ops.push('-');
      i++;
    } else {
      ops.push('+');
      j++;
    }
  }
  while (i++ < n) ops.push('-');
  while (j++ < m) ops.push('+');
  return ops;
}

/** The changed lines of `before` → `after`, each hunk with up to three kept lines around its changes. */
export function lineDiff(before: string, after: string): DiffHunk[] {
  const a = linesOf(before);
  const b = linesOf(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const ops = [
    ...a.slice(0, start).map(() => '=' as const),
    ...middle(a.slice(start, a.length - end), b.slice(start, b.length - end)),
    ...a.slice(a.length - end).map(() => '=' as const),
  ];
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === '-') {
      all.push({ sign: '-', text: a[i], no: i + 1 });
      i++;
      continue;
    }
    all.push({ sign: op === '=' ? ' ' : '+', text: b[j], no: j + 1 });
    if (op === '=') i++;
    j++;
  }
  const hunks: DiffHunk[] = [];
  let last = -Infinity;
  all.forEach((line, k) => {
    if (line.sign === ' ') return;
    const from = Math.max(0, k - CONTEXT, last + 1);
    const to = Math.min(all.length - 1, k + CONTEXT);
    const hunk = hunks.at(-1);
    if (hunk && from <= last + 1)
      hunk.lines.push(...all.slice(last + 1, to + 1));
    else hunks.push({ lines: all.slice(from, to + 1) });
    last = Math.max(last, to);
  });
  return hunks;
}
