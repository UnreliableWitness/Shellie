import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { lineTurn, type Turn } from '../brain/sessionDigest';

/**
 * Claude Code transcripts read for the PR draft and the brain lessons without holding the file or parsing every line:
 * a long task's `.jsonl` passes 100 MB, nearly all of it tool output (reading and parsing one whole took 324 ms on the
 * main thread). Lines are streamed, and the ones that can only be tool output are skipped before JSON.parse.
 */

/** A turn and when it was said (epoch ms from the line's `timestamp`; null when the line has none). */
export type TurnAt = Turn & { at: number | null };

/** Longer lines are tool output (file contents, command output); what a person typed or Claude said is far shorter. */
export const LINE_MAX = 100_000;
/** How much of a transcript's end `lastAgentTurnAt` reads. */
export const TAIL_BYTES = 256 * 1024;
/** A tool result line: the JSON key as Claude Code writes it, never as it appears escaped inside typed text. */
const TOOL_RESULT = '"type":"tool_result"';

/** Whether a line could hold a turn: short enough and not a tool result. */
export const mayHoldTurn = (line: string): boolean =>
  line.length <= LINE_MAX && !line.includes(TOOL_RESULT);

/** Adds one line's turn to `out`: consecutive Claude texts (between tool calls) read as one. */
function push(out: TurnAt[], raw: string): void {
  if (!mayHoldTurn(raw)) return;
  const t = lineTurn(raw);
  if (!t) return;
  const last = out[out.length - 1];
  if (last && last.who === 'Claude' && t.who === 'Claude') {
    last.text = `${last.text}\n${t.text}`;
    last.at = t.at ?? last.at;
  } else out.push(t);
}

/**
 * The developer's and Claude's turns of a transcript, in order, from byte `fromByte` on (the file's size at an earlier
 * read, to see only what came after it). `size` is the file's size when the read started. A missing file reads as none.
 */
export async function readClaudeTurns(
  file: string,
  o: { fromByte?: number } = {},
): Promise<{ turns: TurnAt[]; size: number }> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { turns: [], size: 0 };
  }
  const start = Math.min(o.fromByte ?? 0, size);
  const turns: TurnAt[] = [];
  if (start >= size) return { turns, size };
  const lines = createInterface({
    input: createReadStream(file, { start, end: size - 1 }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) push(turns, line);
  } catch {
    // A file that went away mid-read keeps what was read.
  }
  return { turns, size };
}

/** When Claude last said something in a transcript (epoch ms), from its last TAIL_BYTES; null when nothing there. */
export async function lastAgentTurnAt(file: string): Promise<number | null> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await fh.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    // The first line may start mid-way when the tail was cut: it fails to parse and is skipped.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!mayHoldTurn(lines[i])) continue;
      const t = lineTurn(lines[i]);
      if (t?.who === 'Claude' && t.at !== null) return t.at;
    }
    return null;
  } finally {
    await fh.close();
  }
}
