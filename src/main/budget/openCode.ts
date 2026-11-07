import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BRAIN_JOB_TITLE } from '../../shared/brain';
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

/** Whether the database's `session` table has `parent_id` (subagents); older databases have flat sessions. */
const hasParentId = (db: DatabaseSync) =>
  (db.prepare('PRAGMA table_info(session)').all() as { name: string }[]).some(
    (c) => c.name === 'parent_id',
  );

/** One turn of an OpenCode session: what the developer typed or the agent said. */
export type OpenCodeTurn = { who: 'Developer' | 'Agent'; text: string };

const json = (raw: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

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
      const parent = hasParentId(db)
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

  /**
   * The brain terminal's session: the earliest top-level session OpenCode made in one of `dirs` (a folder and its real
   * path) at or after `since` (epoch ms), not a brain job's (by title) and not in `exclude`; null when none.
   */
  terminalSession(
    dirs: readonly string[],
    since: number,
    exclude: ReadonlySet<string>,
  ): string | null {
    if (!existsSync(this.file) || dirs.length === 0) return null;
    const db = new DatabaseSync(this.file, { readOnly: true, timeout: 2000 });
    try {
      return (
        topSessions(db, dirs, since).find((id) => !exclude.has(id)) ?? null
      );
    } finally {
      db.close();
    }
  }

  /**
   * What was said in each top-level session OpenCode made in one of `dirs` (a folder and its real path) at or after
   * `since` (epoch ms), oldest first, brain jobs left out: text parts by the message's role, not the ones OpenCode
   * injected (`synthetic`), the agent's consecutive texts as one turn.
   */
  sessionTexts(dirs: readonly string[], since = 0): OpenCodeTurn[][] {
    if (!existsSync(this.file) || dirs.length === 0) return [];
    const db = new DatabaseSync(this.file, { readOnly: true, timeout: 2000 });
    try {
      const ids = topSessions(db, dirs, since);
      if (ids.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT part.session_id AS session_id, part.message_id AS message_id, part.data AS data, message.data AS message FROM part JOIN message ON message.id = part.message_id WHERE part.session_id IN (${ids.map(() => '?').join(', ')}) ORDER BY message.time_created, message.id, part.time_created, part.id`,
        )
        .all(...ids) as {
        session_id: string;
        message_id: string;
        data: string;
        message: string;
      }[];
      const bySession = new Map<string, OpenCodeTurn[]>(
        ids.map((id) => [id, []]),
      );
      let lastMessage = '';
      for (const r of rows) {
        const part = json(r.data);
        if (
          part.type !== 'text' ||
          part.synthetic === true ||
          typeof part.text !== 'string'
        )
          continue;
        const text = part.text.trim();
        const role = json(r.message).role;
        if (!text || (role !== 'user' && role !== 'assistant')) continue;
        const who = role === 'user' ? 'Developer' : 'Agent';
        const turns = bySession.get(r.session_id)!;
        const prev = turns.at(-1);
        // The agent's texts between tool calls read as one turn, and so do the parts of one typed message.
        if (
          prev?.who === who &&
          (who === 'Agent' || lastMessage === r.message_id)
        )
          prev.text = `${prev.text}\n${text}`;
        else turns.push({ who, text });
        lastMessage = r.message_id;
      }
      return ids.map((id) => bySession.get(id)!);
    } finally {
      db.close();
    }
  }
}

/** Top-level sessions in one of `dirs` created at or after `since`, oldest first, brain jobs (by title) left out. */
function topSessions(
  db: DatabaseSync,
  dirs: readonly string[],
  since: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM session WHERE directory IN (${dirs.map(() => '?').join(', ')}) AND time_created >= ? AND title NOT LIKE ?${hasParentId(db) ? ' AND parent_id IS NULL' : ''} ORDER BY time_created, id`,
    )
    .all(...dirs, since, `${BRAIN_JOB_TITLE}%`) as { id: string }[];
  return rows.map((r) => r.id);
}
