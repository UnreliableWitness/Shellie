import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BudgetRecord } from '../../shared/budget';

const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** One OpenCode `message` row as a budget record; null unless it is a finished assistant message. A child session (a subagent) carries its parent. */
export function parseOpenCodeMessage(
  id: string,
  sessionId: string,
  data: string,
  parentSessionId?: string | null,
): BudgetRecord | null {
  let d: {
    role?: string;
    agent?: string;
    mode?: string;
    modelID?: string;
    providerID?: string;
    path?: { cwd?: string };
    tokens?: {
      input?: number;
      output?: number;
      cache?: { read?: number; write?: number };
    };
    time?: { created?: number; completed?: number | null };
  };
  try {
    d = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    d.role !== 'assistant' ||
    !d.time?.completed ||
    !d.time.created ||
    !d.modelID
  )
    return null;
  const agent = d.agent ?? d.mode;
  return {
    id: `oc:${id}`,
    tool: 'opencode',
    sessionId,
    model: d.modelID,
    provider: d.providerID ?? '',
    at: new Date(d.time.created).toISOString(),
    cwd: d.path?.cwd ?? null,
    fast: false,
    inputTokens: n(d.tokens?.input),
    outputTokens: n(d.tokens?.output),
    cacheReadTokens: n(d.tokens?.cache?.read),
    // OpenCode does not say which cache TTL it wrote; priced as 5-minute writes (spec, our call).
    cacheWrite5mTokens: n(d.tokens?.cache?.write),
    cacheWrite1hTokens: 0,
    ...(parentSessionId && {
      parentSessionId,
      ...(agent && { agentLabel: agent }),
    }),
  };
}

export function openCodeDbPath(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  const base = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'opencode', 'opencode.db');
}

/** Size and modification time of the database and its write-ahead log; any write OpenCode makes changes one of them. */
function fingerprint(file: string): string {
  const part = (f: string) => {
    try {
      const st = statSync(f);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return '-';
    }
  };
  return `${part(file)}|${part(`${file}-wal`)}`;
}

/** Reads OpenCode's SQLite database read-only; OpenCode may be writing (WAL), so a busy database waits briefly. */
export class OpenCodeReader {
  /**
   * The files as they were before the last read that reached the end, and the cursor it returned. Its
   * `message` table has no index on `time_updated`, so every query reads the whole table: a read at that
   * cursor of unchanged files is answered without opening the database.
   */
  private unchanged: { fingerprint: string; cursor: number } | null = null;
  /** A paged read in progress: the fingerprint taken at its first page and the newest cursor of its pages so far. */
  private paging: { fingerprint: string; cursor: number } | null = null;

  constructor(
    private readonly file: string,
    /** First read (cursor 0) starts here, epoch ms: the same window as the transcripts. */
    private readonly opts: { since?: number } = {},
  ) {}

  /**
   * Messages updated at or after `cursor`. With `page`, at most `limit` rows, ordered by (time_updated, id)
   * and starting after `page.after`, so a caller can read a large backlog in chunks; `more` says another
   * page may follow and `last` is where it starts.
   */
  read(
    cursor: number,
    page?: { limit: number; after?: { t: number; id: string } },
  ): {
    records: BudgetRecord[];
    cursor: number;
    found: boolean;
    more?: boolean;
    last?: { t: number; id: string };
  } {
    if (!existsSync(this.file)) return { records: [], cursor, found: false };
    const after = page?.after;
    // Taken before the query, so a write during it shows as a change next time.
    let fp: string;
    if (after && this.paging) fp = this.paging.fingerprint;
    else {
      fp = fingerprint(this.file);
      if (
        this.unchanged?.fingerprint === fp &&
        this.unchanged.cursor === cursor
      )
        return page
          ? { records: [], cursor, found: true, more: false }
          : { records: [], cursor, found: true };
      this.paging = page ? { fingerprint: fp, cursor } : null;
    }
    const from = cursor === 0 ? (this.opts.since ?? 0) : cursor;
    const db = new DatabaseSync(this.file, { readOnly: true, timeout: 2000 });
    try {
      // A subagent runs in a child session; older databases without `session.parent_id` read as flat sessions.
      const hasParent = (
        db.prepare('PRAGMA table_info(session)').all() as { name: string }[]
      ).some((c) => c.name === 'parent_id');
      const parent = hasParent
        ? ', (SELECT parent_id FROM session WHERE session.id = message.session_id) AS parent_id'
        : '';
      const rows = (
        page
          ? db
              .prepare(
                after
                  ? `SELECT id, session_id, time_updated, data${parent} FROM message WHERE time_updated > ? OR (time_updated = ? AND id > ?) ORDER BY time_updated, id LIMIT ?`
                  : `SELECT id, session_id, time_updated, data${parent} FROM message WHERE time_updated >= ? ORDER BY time_updated, id LIMIT ?`,
              )
              .all(
                ...(after
                  ? [after.t, after.t, after.id, page.limit]
                  : [from, page.limit]),
              )
          : db
              .prepare(
                `SELECT id, session_id, time_updated, data${parent} FROM message WHERE time_updated >= ? ORDER BY time_updated`,
              )
              // `>=`: a row updated in the same millisecond as the cursor is not missed; the store ignores repeats.
              .all(from)
      ) as {
        id: string;
        session_id: string;
        time_updated: number;
        data: string;
        parent_id?: string | null;
      }[];
      const records: BudgetRecord[] = [];
      let next = from;
      for (const r of rows) {
        next = Math.max(next, r.time_updated);
        const rec = parseOpenCodeMessage(
          r.id,
          r.session_id,
          r.data,
          r.parent_id,
        );
        if (rec) records.push(rec);
      }
      if (!page) {
        this.unchanged = { fingerprint: fp, cursor: next };
        return { records, cursor: next, found: true };
      }
      const lastRow = rows.at(-1);
      const more = rows.length === page.limit;
      // A paged read's cursor is the largest of its pages (the last one can come back empty).
      if (this.paging) this.paging.cursor = Math.max(this.paging.cursor, next);
      if (!more) {
        this.unchanged = {
          fingerprint: fp,
          cursor: this.paging?.cursor ?? next,
        };
        this.paging = null;
      }
      return {
        records,
        cursor: next,
        found: true,
        more,
        last: lastRow ? { t: lastRow.time_updated, id: lastRow.id } : after,
      };
    } finally {
      db.close();
    }
  }
}
