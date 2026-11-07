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

  it('answers a read of unchanged files without querying, and sees the next write', () => {
    const { file, put, close } = makeDb();
    put('m1', 100, msg());
    put('m2', 200, msg());
    const reader = new OpenCodeReader(file);
    const first = reader.read(0);
    // A query would bring m2 back (time_updated >= cursor); nothing changed, so nothing is read.
    expect(reader.read(first.cursor).records).toEqual([]);
    put('m3', 300, msg());
    const next = reader.read(first.cursor);
    expect(next.records.map((r) => r.id)).toEqual(['oc:m2', 'oc:m3']);
    expect(next.cursor).toBe(300);
    // Another cursor than the one the last read returned is always queried.
    expect(reader.read(100).records.map((r) => r.id)).toEqual([
      'oc:m1',
      'oc:m2',
      'oc:m3',
    ]);
    close();
  });

  it('skips a paged read of unchanged files at the cursor its pages ended on', () => {
    const { file, put, close } = makeDb();
    put('a', 100, msg());
    put('b', 200, msg());
    const reader = new OpenCodeReader(file);
    const one = reader.read(0, { limit: 2 });
    expect(one.more).toBe(true);
    // The second page comes back empty; the cursor is still the newest of the pages.
    const two = reader.read(0, { limit: 2, after: one.last });
    expect(two.records).toEqual([]);
    expect(two.more).toBe(false);
    const again = reader.read(Math.max(one.cursor, two.cursor), { limit: 2 });
    expect(again).toEqual({
      records: [],
      cursor: 200,
      found: true,
      more: false,
    });
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

describe('OpenCodeReader.terminalSession', () => {
  const makeDb = (withParent = true) => {
    const file = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'oc-ses-')),
      'opencode.db',
    );
    const db = new DatabaseSync(file);
    db.exec(
      `CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, ${withParent ? 'parent_id text, ' : ''}slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)`,
    );
    const put = (
      id: string,
      directory: string,
      created: number,
      o: { parent?: string; title?: string } = {},
    ) => {
      const title = o.title ?? 'New session';
      if (withParent)
        db.prepare(
          'INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          id,
          'p',
          o.parent ?? null,
          id,
          directory,
          title,
          '1',
          created,
          created,
        );
      else
        db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          id,
          'p',
          id,
          directory,
          title,
          '1',
          created,
          created,
        );
    };
    return { file, put, close: () => db.close() };
  };

  it('finds the earliest top-level session in the folder since a time, never a job', () => {
    const { file, put, close } = makeDb();
    put('ses_old', '/b', 50);
    put('ses_job', '/b', 110, { title: 'Shellie brain job: capture' });
    put('ses_excluded', '/b', 115);
    put('ses_child', '/b', 118, { parent: 'ses_term' });
    put('ses_term', '/b', 120);
    put('ses_later', '/b', 150);
    put('ses_other', '/elsewhere', 105);
    const reader = new OpenCodeReader(file);
    expect(reader.terminalSession(['/b'], 100, new Set(['ses_excluded']))).toBe(
      'ses_term',
    );
    expect(reader.terminalSession(['/b'], 130, new Set())).toBe('ses_later');
    expect(reader.terminalSession(['/b'], 200, new Set())).toBeNull();
    expect(reader.terminalSession(['/c'], 0, new Set())).toBeNull();
    // OpenCode stores the real path: either spelling of the folder matches.
    expect(
      reader.terminalSession(['/tmp/x', '/elsewhere'], 100, new Set()),
    ).toBe('ses_other');
    close();
  });

  it('reads a database without parent_id, and none at all', () => {
    const { file, put, close } = makeDb(false);
    put('ses_a', '/b', 10);
    expect(new OpenCodeReader(file).terminalSession(['/b'], 0, new Set())).toBe(
      'ses_a',
    );
    close();
    expect(
      new OpenCodeReader('/nope/opencode.db').terminalSession(
        ['/b'],
        0,
        new Set(),
      ),
    ).toBeNull();
  });

  it('says whether a session exists; unknown (null) without a database', () => {
    const { file, put, close } = makeDb();
    put('ses_a', '/b', 10);
    const reader = new OpenCodeReader(file);
    expect(reader.sessionExists('ses_a')).toBe(true);
    expect(reader.sessionExists('ses_gone')).toBe(false);
    close();
    expect(new OpenCodeReader('/nope/opencode.db').sessionExists('ses_a')).toBe(
      null,
    );
  });
});

describe('OpenCodeReader.sessionTexts', () => {
  const makeDb = () => {
    const file = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'oc-txt-')),
      'opencode.db',
    );
    const db = new DatabaseSync(file);
    db.exec(
      'CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)',
    );
    db.exec(
      'CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)',
    );
    db.exec(
      'CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)',
    );
    const session = (
      id: string,
      directory: string,
      created: number,
      o: { parent?: string; title?: string } = {},
    ) =>
      db
        .prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          id,
          'p',
          o.parent ?? null,
          id,
          directory,
          o.title ?? 'New session',
          '1',
          created,
          created,
        );
    let n = 0;
    /** One message with its parts, each a text unless given as an object. */
    const say = (
      sessionId: string,
      role: string,
      t: number,
      parts: (string | Record<string, unknown>)[],
    ) => {
      const id = `msg_${++n}`;
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
        id,
        sessionId,
        t,
        t,
        JSON.stringify({ role }),
      );
      parts.forEach((p, i) =>
        db
          .prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            `prt_${n}_${i}`,
            id,
            sessionId,
            t + i,
            t + i,
            JSON.stringify(
              typeof p === 'string' ? { type: 'text', text: p } : p,
            ),
          ),
      );
    };
    return { file, session, say, close: () => db.close() };
  };

  it("returns each top-level session's texts in order, roles mapped, consecutive agent parts joined", () => {
    const { file, session, say, close } = makeDb();
    session('ses_b', '/w', 200);
    session('ses_a', '/private/w', 100);
    session('ses_child', '/w', 150, { parent: 'ses_a' });
    session('ses_job', '/w', 160, { title: 'Shellie brain job: capture' });
    session('ses_other', '/elsewhere', 120);
    say('ses_a', 'user', 100, [
      'Fix the bug',
      { type: 'text', text: 'injected', synthetic: true },
    ]);
    say('ses_a', 'assistant', 110, [
      'Looking.',
      { type: 'tool', tool: 'read' },
      'Found it.',
    ]);
    say('ses_a', 'assistant', 120, ['Fixed.']);
    say('ses_a', 'user', 130, ['Thanks']);
    say('ses_child', 'user', 150, ['subagent task']);
    say('ses_job', 'user', 160, ['job prompt']);
    say('ses_other', 'user', 120, ['elsewhere']);
    say('ses_b', 'user', 200, ['Second']);
    expect(new OpenCodeReader(file).sessionTexts(['/w', '/private/w'])).toEqual(
      [
        [
          { who: 'Developer', text: 'Fix the bug' },
          { who: 'Agent', text: 'Looking.\nFound it.\nFixed.' },
          { who: 'Developer', text: 'Thanks' },
        ],
        [{ who: 'Developer', text: 'Second' }],
      ],
    );
    expect(new OpenCodeReader(file).sessionTexts(['/w'], 150)).toEqual([
      [{ who: 'Developer', text: 'Second' }],
    ]);
    close();
    expect(
      new OpenCodeReader('/nope/opencode.db').sessionTexts(['/w']),
    ).toEqual([]);
  });
});
