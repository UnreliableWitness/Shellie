import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  OpenCodeReader,
  openCodeDbPath,
  parseOpenCodeMessage,
} from './openCode';

const msg = (
  o: Partial<{
    provider: string;
    model: string;
    role: string;
    completed: number | null;
    output: number;
  }> = {},
) =>
  JSON.stringify({
    role: o.role ?? 'assistant',
    path: { cwd: '/w/repo', root: '/w/repo' },
    cost: 0,
    tokens: {
      total: 0,
      input: 3,
      output: o.output ?? 4,
      reasoning: 0,
      cache: { write: 12018, read: 7 },
    },
    modelID: o.model ?? 'claude-sonnet-5-5',
    providerID: o.provider ?? 'anthropic',
    time: {
      created: 1792384827209,
      completed: o.completed === undefined ? 1792384829895 : o.completed,
    },
  });

describe('parseOpenCodeMessage', () => {
  it('maps tokens and provider', () => {
    expect(parseOpenCodeMessage('m1', 'ses1', msg())).toEqual({
      id: 'oc:m1',
      tool: 'opencode',
      sessionId: 'ses1',
      model: 'claude-sonnet-5-5',
      provider: 'anthropic',
      at: new Date(1792384827209).toISOString(),
      cwd: '/w/repo',
      fast: false,
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheWrite5mTokens: 12018,
      cacheWrite1hTokens: 0,
    });
  });
  it("gives a child session's message its parent and agent", () => {
    const data = JSON.stringify({ ...JSON.parse(msg()), agent: 'explore' });
    expect(parseOpenCodeMessage('m1', 'ses2', data, 'ses1')).toMatchObject({
      sessionId: 'ses2',
      parentSessionId: 'ses1',
      agentLabel: 'explore',
    });
    const top = parseOpenCodeMessage('m1', 'ses1', data, null);
    expect(top).not.toHaveProperty('parentSessionId');
    expect(top).not.toHaveProperty('agentLabel');
  });
  it('skips user messages, unfinished messages and bad JSON', () => {
    expect(parseOpenCodeMessage('m', 's', msg({ role: 'user' }))).toBeNull();
    expect(parseOpenCodeMessage('m', 's', msg({ completed: null }))).toBeNull();
    expect(parseOpenCodeMessage('m', 's', '{')).toBeNull();
  });
});

describe('openCodeDbPath', () => {
  it('uses XDG_DATA_HOME', () =>
    expect(openCodeDbPath({ XDG_DATA_HOME: '/x' }, '/h')).toBe(
      path.join('/x', 'opencode', 'opencode.db'),
    ));
  it('defaults to ~/.local/share', () =>
    expect(openCodeDbPath({}, '/h')).toBe(
      path.join('/h', '.local', 'share', 'opencode', 'opencode.db'),
    ));
});

describe('OpenCodeReader', () => {
  const makeDb = () => {
    const file = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'oc-')),
      'opencode.db',
    );
    const db = new DatabaseSync(file);
    db.exec(
      `CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
    );
    const put = (id: string, updated: number, data: string, session = 'ses1') =>
      db
        .prepare('INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?, ?)')
        .run(id, session, 1, updated, data);
    return { file, put, db, close: () => db.close() };
  };

  it('reads new messages after the cursor, all providers', () => {
    const { file, put, close } = makeDb();
    put('m1', 100, msg());
    put(
      'm2',
      200,
      msg({ provider: 'github-copilot', model: 'claude-sonnet-4.6' }),
    );
    const reader = new OpenCodeReader(file);
    const first = reader.read(0);
    expect(first.records.map((r) => [r.id, r.provider])).toEqual([
      ['oc:m1', 'anthropic'],
      ['oc:m2', 'github-copilot'],
    ]);
    expect(first.cursor).toBe(200);
    put('m1', 300, msg({ output: 400 }));
    const second = reader.read(first.cursor);
    // Rows at the cursor come back again (time_updated >= cursor); the store ignores the repeat.
    expect(second.records.map((r) => [r.id, r.outputTokens])).toEqual([
      ['oc:m2', 4],
      ['oc:m1', 400],
    ]);
    expect(second.cursor).toBe(300);
    close();
  });

  it('reads a page at a time, after the last row of the previous page', () => {
    const { file, put, close } = makeDb();
    // Five rows, three in the same millisecond: paging must not stall or skip.
    put('a', 100, msg());
    put('b', 200, msg());
    put('c', 200, msg());
    put('d', 200, msg());
    put('e', 300, msg());
    const reader = new OpenCodeReader(file);
    const seen: string[] = [];
    let after: { t: number; id: string } | undefined;
    let cursor = 0;
    for (let i = 0; i < 10; i++) {
      const p = reader.read(0, { limit: 2, after });
      expect(p.records.length).toBeLessThanOrEqual(2);
      seen.push(...p.records.map((r) => r.id));
      cursor = Math.max(cursor, p.cursor);
      if (!p.more) break;
      after = p.last;
    }
    expect(seen).toEqual(['oc:a', 'oc:b', 'oc:c', 'oc:d', 'oc:e']);
    expect(cursor).toBe(300);
    close();
  });

  it("reads a child session's parent from the session table", () => {
    const { file, put, close, db } = makeDb();
    db.exec(
      `CREATE TABLE session (id text PRIMARY KEY, parent_id text, title text NOT NULL)`,
    );
    db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses1', null, 'a');
    db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses2', 'ses1', 'b');
    put('m1', 100, msg());
    put('m2', 200, msg(), 'ses2');
    put('m3', 300, msg(), 'ses3');
    const r = new OpenCodeReader(file).read(0);
    expect(r.records.map((x) => [x.sessionId, x.parentSessionId])).toEqual([
      ['ses1', undefined],
      ['ses2', 'ses1'],
      ['ses3', undefined],
    ]);
    close();
  });

  it('starts a first read (cursor 0) at `since`', () => {
    const { file, put, close } = makeDb();
    put('old', 100, msg());
    put('new', 500, msg());
    const r = new OpenCodeReader(file, { since: 500 }).read(0);
    expect(r.records.map((x) => x.id)).toEqual(['oc:new']);
    expect(r.cursor).toBe(500);
    close();
  });

  it('reports a missing database as not found', () =>
    expect(new OpenCodeReader('/no/such.db').read(5)).toEqual({
      records: [],
      cursor: 5,
      found: false,
    }));
});
