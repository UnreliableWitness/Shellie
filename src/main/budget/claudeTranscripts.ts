import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BudgetRecord } from '../../shared/budget';
import { tick } from '../async';

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  speed?: string;
};
const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** One Claude Code transcript line as a budget record; null for anything that is not a priced response. */
export function parseTranscriptLine(line: string): BudgetRecord | null {
  let d: {
    type?: string;
    timestamp?: string;
    sessionId?: string;
    cwd?: string;
    message?: { id?: string; model?: string; usage?: Usage };
  };
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const m = d.message;
  if (
    d.type !== 'assistant' ||
    !m?.usage ||
    !m.id ||
    !m.model ||
    m.model === '<synthetic>' ||
    !d.timestamp
  )
    return null;
  const u = m.usage;
  const split = u.cache_creation;
  const w1h = n(split?.ephemeral_1h_input_tokens);
  const w5m = split
    ? n(split.ephemeral_5m_input_tokens)
    : n(u.cache_creation_input_tokens);
  return {
    id: `cc:${m.id}`,
    tool: 'claude-code',
    sessionId: d.sessionId ?? '',
    model: m.model,
    provider: 'anthropic',
    at: d.timestamp,
    cwd: d.cwd ?? null,
    fast: u.speed === 'fast',
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheWrite5mTokens: w5m,
    cacheWrite1hTokens: w1h,
  };
}

export type FileCursor = {
  offset: number;
  size: number;
  mtimeMs: number;
  ino: number;
};

async function* jsonlFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

/** Follows every Claude Code transcript under `root`, reading only bytes appended since the last pass. */
export class ClaudeTranscriptReader {
  private readonly chunkBytes: number;
  constructor(
    private readonly root: string,
    private readonly opts: { since?: number; chunkBytes?: number } = {},
  ) {
    this.chunkBytes = opts.chunkBytes ?? 1024 * 1024;
  }

  async read(cursors: Record<string, FileCursor>) {
    try {
      await fs.access(this.root);
    } catch {
      return {
        records: [] as BudgetRecord[],
        cursors: {} as Record<string, FileCursor>,
        found: false,
      };
    }
    const next: Record<string, FileCursor> = {};
    const records: BudgetRecord[] = [];
    for await (const file of jsonlFiles(this.root)) {
      let st;
      try {
        st = await fs.stat(file);
      } catch {
        continue;
      }
      const prev = cursors[file];
      if (
        !prev &&
        this.opts.since !== undefined &&
        st.mtimeMs < this.opts.since
      ) {
        next[file] = {
          offset: st.size,
          size: st.size,
          mtimeMs: st.mtimeMs,
          ino: st.ino,
        };
        continue;
      }
      const reset = !prev || st.size < prev.offset || st.ino !== prev.ino;
      const from = reset ? 0 : prev.offset;
      if (!reset && st.size === prev.size && st.mtimeMs === prev.mtimeMs) {
        next[file] = prev;
        continue;
      }
      // A file can vanish or become unreadable between listing and reading: skip it, keep its cursor.
      const mine: BudgetRecord[] = [];
      let fh;
      try {
        fh = await fs.open(file, 'r');
      } catch (err) {
        console.warn('[budget] skipping unreadable transcript', file, err);
        if (prev) next[file] = prev;
        continue;
      }
      try {
        const chunk = Buffer.alloc(this.chunkBytes);
        let pos = from;
        let carry = Buffer.alloc(0);
        while (pos < st.size) {
          const { bytesRead } = await fh.read(
            chunk,
            0,
            Math.min(chunk.length, st.size - pos),
            pos,
          );
          if (bytesRead === 0) break;
          pos += bytesRead;
          const data = carry.length
            ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
            : chunk.subarray(0, bytesRead);
          const end = data.lastIndexOf(0x0a);
          if (end >= 0) {
            for (const l of data
              .subarray(0, end)
              .toString('utf8')
              .split('\n')) {
              const r = l && parseTranscriptLine(l);
              if (r) mine.push(r);
            }
          }
          carry = Buffer.from(data.subarray(end + 1));
          await tick();
        }
        next[file] = {
          offset: pos - carry.length,
          size: st.size,
          mtimeMs: st.mtimeMs,
          ino: st.ino,
        };
        for (const r of mine) records.push(r);
      } catch (err) {
        console.warn('[budget] skipping unreadable transcript', file, err);
        if (prev) next[file] = prev;
        else delete next[file];
      } finally {
        await fh.close().catch(() => undefined);
      }
      await tick();
    }
    return { records, cursors: next, found: true };
  }
}
