import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from './server';
import {
  call,
  cleanUp,
  INVITE,
  itemId,
  join,
  put,
  raw,
  signUp,
  someone,
  start,
  tempDir,
} from './testing';

afterEach(cleanUp);

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

describe('defaults', () => {
  it('has the limits of the design', () => {
    expect(DEFAULT_LIMITS).toEqual({
      itemBytes: 1024 * 1024,
      accountItems: 2000,
      accountBytes: 200 * 1024 * 1024,
      requestsPerMinute: 1200,
      failuresPerMinute: 20,
    });
  });
});

describe('health', () => {
  it('answers 200 ok', async () => {
    const server = await start();
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('refuses another method', async () => {
    const server = await start();
    const res = await fetch(`${server.url}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('signing up', () => {
  it('makes the account and keeps a hash of the token, not the token', async () => {
    const server = await start();
    const who = someone();
    const res = await signUp(server, who);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const file = path.join(
      server.dataDir,
      'readers',
      who.reader,
      'reader.json',
    );
    const stored = await fs.readFile(file, 'utf8');
    expect(stored).not.toContain(who.token);
    expect(JSON.parse(stored)).toMatchObject({
      v: 1,
      tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      created: '2026-11-11T10:00:00.000Z',
      counter: 0,
      items: {},
    });
  });

  it('answers 200 again with the same token and 409 with another', async () => {
    const server = await start();
    const who = await join(server);
    const again = await signUp(server, who);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ created: false });
    const other = await signUp(server, { ...who, token: someone().token });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: 'conflict' });
    // the first token still works
    expect((await call(server, who, 'GET', '/api/v1/hello')).status).toBe(200);
  });

  it('refuses a wrong or missing invitation', async () => {
    const server = await start();
    const who = someone();
    for (const invite of ['wrong', '', null, `${INVITE}x`]) {
      const res = await signUp(server, who, invite);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    }
    expect(await exists(path.join(server.dataDir, 'readers'))).toBe(false);
  });

  it('lets nobody sign up when the server has no invitation code', async () => {
    const server = await start({ invite: '' });
    expect((await signUp(server, someone(), '')).status).toBe(403);
    expect((await signUp(server, someone(), null)).status).toBe(403);
  });

  it('refuses ids and tokens of the wrong shape', async () => {
    const server = await start();
    const good = someone();
    const bad = [
      { ...good, reader: '../../../etc' },
      { ...good, reader: good.reader.toUpperCase() },
      { ...good, reader: good.reader.slice(1) },
      { ...good, token: `${good.token}a` },
      { ...good, token: good.token.replace(/.$/, '/') },
    ];
    for (const who of bad) expect((await signUp(server, who)).status).toBe(400);
    expect(await exists(path.join(server.dataDir, 'readers'))).toBe(false);
  });

  it('refuses a body that is not JSON, or too large', async () => {
    const server = await start();
    const post = (body: string) =>
      fetch(`${server.url}/api/v1/readers`, { method: 'POST', body });
    expect((await post('not json')).status).toBe(400);
    expect((await post(JSON.stringify('x'.repeat(5000)))).status).toBe(413);
  });

  it('refuses another method', async () => {
    const server = await start();
    const res = await fetch(`${server.url}/api/v1/readers`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('the bearer', () => {
  it('says hello to an account', async () => {
    const server = await start();
    const who = await join(server);
    const res = await call(server, who, 'GET', '/api/v1/hello');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ server: 'shellie-reader', v: 1 });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('answers the same 401 for none, a malformed one, an unknown account and a wrong token', async () => {
    const server = await start({ limits: { failuresPerMinute: 1000 } });
    const who = await join(server);
    const wrong = { ...who, bearer: `Bearer ${who.reader}.${someone().token}` };
    const malformed = { ...who, bearer: `Bearer ${who.reader}` };
    const basic = { ...who, bearer: `Basic ${who.reader}.${who.token}` };
    const answers = [];
    for (const as of [null, malformed, basic, someone(), wrong]) {
      for (const [method, pathname] of [
        ['GET', '/api/v1/hello'],
        ['GET', '/api/v1/items'],
        ['GET', `/api/v1/items/${itemId()}`],
        ['PUT', `/api/v1/items/${itemId()}`],
        ['DELETE', `/api/v1/items/${itemId()}`],
        ['DELETE', '/api/v1/reader'],
      ]) {
        const res = await call(server, as, method, pathname);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
        answers.push(`${res.status} ${await res.text()}`);
      }
    }
    expect(new Set(answers)).toEqual(new Set(['401 {"error":"unauthorized"}']));
    expect((await call(server, who, 'GET', '/api/v1/hello')).status).toBe(200);
  });
});

describe('items', () => {
  it('stores, lists, answers and removes the bytes', async () => {
    const server = await start();
    const who = await join(server);
    const id = itemId('m');
    const bytes = new Uint8Array([1, 0, 255, 254, 10, 13, 0]);

    const empty = await call(server, who, 'GET', '/api/v1/items');
    expect(await empty.json()).toEqual({ items: [] });

    const stored = await call(server, who, 'PUT', `/api/v1/items/${id}`, bytes);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ rev: 1 });
    expect(stored.headers.get('etag')).toBe('"1"');

    const got = await call(server, who, 'GET', `/api/v1/items/${id}`);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    expect(got.headers.get('etag')).toBe('"1"');
    expect(got.headers.get('cache-control')).toBe('no-store');
    expect(got.headers.get('content-type')).toBe('application/octet-stream');

    const list = await call(server, who, 'GET', '/api/v1/items');
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect(await list.json()).toEqual({
      items: [{ id, rev: 1, size: 7, at: '2026-11-11T10:00:00.000Z' }],
    });
    const file = path.join(server.dataDir, 'readers', who.reader, 'items', id);
    expect(new Uint8Array(await fs.readFile(file))).toEqual(bytes);

    const gone = await call(server, who, 'DELETE', `/api/v1/items/${id}`);
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe('');
    expect(await exists(file)).toBe(false);
    const after = await call(server, who, 'GET', `/api/v1/items/${id}`);
    expect(after.status).toBe(404);
    expect(await after.json()).toEqual({ error: 'not_found' });
    const list2 = await call(server, who, 'GET', '/api/v1/items');
    expect(await list2.json()).toEqual({ items: [] });
  });

  it('answers 404 for an item it does not have', async () => {
    const server = await start();
    const who = await join(server);
    const pathname = `/api/v1/items/${itemId()}`;
    expect((await call(server, who, 'GET', pathname)).status).toBe(404);
    expect((await call(server, who, 'DELETE', pathname)).status).toBe(404);
  });

  it('gives a newer write a higher rev, across items and removals', async () => {
    const server = await start();
    const who = await join(server);
    const [a, b] = [itemId('r'), itemId('p')];
    expect(await (await put(server, who, a, 'one')).json()).toEqual({ rev: 1 });
    expect(await (await put(server, who, b, 'two')).json()).toEqual({ rev: 2 });
    expect(await (await put(server, who, a, 'three')).json()).toEqual({
      rev: 3,
    });
    await call(server, who, 'DELETE', `/api/v1/items/${a}`);
    expect(await (await put(server, who, a, 'four')).json()).toEqual({
      rev: 4,
    });
    const list = await call(server, who, 'GET', '/api/v1/items');
    const { items } = (await list.json()) as { items: { id: string }[] };
    expect(items).toMatchObject([
      { id: b, rev: 2, size: 3 },
      { id: a, rev: 4, size: 4 },
    ]);
  });

  it('keeps the index whole under writes at the same time', async () => {
    const server = await start();
    const who = await join(server);
    const ids = Array.from({ length: 25 }, () => itemId());
    const answers = await Promise.all(
      ids.map((id) => put(server, who, id, `text of ${id}`)),
    );
    const revs = await Promise.all(
      answers.map(async (res) => ((await res.json()) as { rev: number }).rev),
    );
    expect(revs.toSorted((x, y) => x - y)).toEqual(ids.map((_, i) => i + 1));
    const dir = path.join(server.dataDir, 'readers', who.reader);
    const index = JSON.parse(
      await fs.readFile(path.join(dir, 'reader.json'), 'utf8'),
    );
    expect(index.counter).toBe(25);
    expect(Object.keys(index.items).toSorted()).toEqual(ids.toSorted());
    // no temp file stays behind
    expect(await fs.readdir(dir)).toEqual(['items', 'reader.json']);
    expect((await fs.readdir(path.join(dir, 'items'))).toSorted()).toEqual(
      ids.toSorted(),
    );
  });

  it('refuses another method', async () => {
    const server = await start();
    const who = await join(server);
    const one = await call(server, who, 'POST', `/api/v1/items/${itemId()}`);
    expect(one.status).toBe(405);
    expect(one.headers.get('allow')).toBe('GET, PUT, DELETE');
    const all = await call(server, who, 'DELETE', '/api/v1/items');
    expect(all.status).toBe(405);
    expect(all.headers.get('allow')).toBe('GET');
    expect((await call(server, who, 'POST', '/api/v1/hello')).status).toBe(405);
    expect((await call(server, who, 'GET', '/api/v1/reader')).status).toBe(405);
  });
});

describe('If-Match and If-None-Match', () => {
  it('writes with If-None-Match: * only when the item is absent', async () => {
    const server = await start();
    const who = await join(server);
    const id = itemId('k');
    const absent = { 'If-None-Match': '*' };
    expect((await put(server, who, id, 'first', absent)).status).toBe(200);
    const second = await put(server, who, id, 'second', absent);
    expect(second.status).toBe(412);
    expect(await second.json()).toEqual({ error: 'precondition_failed' });
    const got = await call(server, who, 'GET', `/api/v1/items/${id}`);
    expect(await got.text()).toBe('first');
  });

  it('writes with If-Match only over that revision', async () => {
    const server = await start();
    const who = await join(server);
    const id = itemId('k');
    const over = (rev: string) => ({ 'If-Match': rev });
    // absent: nothing to match
    expect((await put(server, who, id, 'x', over('"1"'))).status).toBe(412);
    expect((await put(server, who, id, 'x', over('*'))).status).toBe(412);
    await put(server, who, itemId(), 'another item takes rev 1');
    expect(await (await put(server, who, id, 'a')).json()).toEqual({ rev: 2 });
    expect((await put(server, who, id, 'b', over('"1"'))).status).toBe(412);
    const ok = await put(server, who, id, 'b', over('"2"'));
    expect(await ok.json()).toEqual({ rev: 3 });
    // the revision it was written over is now stale
    expect((await put(server, who, id, 'c', over('"2"'))).status).toBe(412);
    expect((await put(server, who, id, 'c', over('*'))).status).toBe(200);
    const got = await call(server, who, 'GET', `/api/v1/items/${id}`);
    expect(await got.text()).toBe('c');
    expect(got.headers.get('etag')).toBe('"4"');
  });

  it('lets one of two writers over the same revision win', async () => {
    const server = await start();
    const who = await join(server);
    const id = itemId('k');
    await put(server, who, id, 'base');
    const both = await Promise.all(
      ['left', 'right'].map((text) =>
        put(server, who, id, text, { 'If-Match': '"1"' }),
      ),
    );
    expect(both.map((res) => res.status).toSorted()).toEqual([200, 412]);
  });

  it('refuses a condition it does not know', async () => {
    const server = await start();
    const who = await join(server);
    const id = itemId();
    const unknown: Record<string, string>[] = [
      { 'If-Match': '1' },
      { 'If-Match': '"abc"' },
      { 'If-None-Match': '"1"' },
    ];
    for (const headers of unknown)
      expect((await put(server, who, id, 'x', headers)).status).toBe(400);
    expect((await call(server, who, 'GET', `/api/v1/items/${id}`)).status).toBe(
      404,
    );
  });
});

describe('the id guards', () => {
  it('refuses an item id of the wrong shape before the disk', async () => {
    const server = await start();
    const who = await join(server);
    const good = itemId();
    const bad = [
      '../reader.json',
      '..%2Freader.json',
      '%2e%2e%2freader.json',
      `../../${who.reader}/reader.json`,
      `${good}/..`,
      `${good}/x`,
      good.slice(2),
      good.toUpperCase(),
      `R${good.slice(1)}`,
      `${good}0`,
      `${good}.tmp`,
      `rr${good.slice(1)}`,
      '',
    ];
    const headers = { Authorization: who.bearer };
    for (const id of bad) {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const res = await raw(server, method, `/api/v1/items/${id}`, headers);
        expect(`${method} ${id} ${res.status}`).toBe(`${method} ${id} 400`);
        expect(JSON.parse(res.body)).toEqual({ error: 'bad_request' });
      }
    }
    const dir = path.join(server.dataDir, 'readers', who.reader);
    expect(await fs.readdir(dir)).toEqual(['items', 'reader.json']);
    expect(await fs.readdir(path.join(dir, 'items'))).toEqual([]);
  });

  it('does not take a reader id that is a path', async () => {
    const server = await start();
    const who = await join(server);
    const res = await raw(server, 'GET', '/api/v1/items', {
      Authorization: `Bearer ../${who.reader}.${who.token}`,
    });
    expect(res.status).toBe(401);
  });
});

describe('accounts', () => {
  it('keeps one account out of another', async () => {
    const server = await start();
    const [ann, bob] = [await join(server), await join(server)];
    const id = itemId();
    await put(server, ann, id, 'for ann');
    expect((await call(server, bob, 'GET', `/api/v1/items/${id}`)).status).toBe(
      404,
    );
    const list = await call(server, bob, 'GET', '/api/v1/items');
    expect(await list.json()).toEqual({ items: [] });
    expect(
      (await call(server, bob, 'DELETE', `/api/v1/items/${id}`)).status,
    ).toBe(404);
    // the same id is another item in another account, with its own revs
    expect(await (await put(server, bob, id, 'for bob')).json()).toEqual({
      rev: 1,
    });
    const anns = await call(server, ann, 'GET', `/api/v1/items/${id}`);
    expect(await anns.text()).toBe('for ann');
    // one's reader id with the other's token is nobody
    const mixed = { ...ann, bearer: `Bearer ${ann.reader}.${bob.token}` };
    expect((await call(server, mixed, 'GET', '/api/v1/items')).status).toBe(
      401,
    );
  });

  it('removes the account and its files', async () => {
    const server = await start();
    const [ann, bob] = [await join(server), await join(server)];
    const id = itemId();
    await put(server, ann, id, 'for ann');
    await put(server, bob, id, 'for bob');
    const res = await call(server, ann, 'DELETE', '/api/v1/reader');
    expect(res.status).toBe(204);
    const readers = path.join(server.dataDir, 'readers');
    expect(await fs.readdir(readers)).toEqual([bob.reader]);
    expect((await call(server, ann, 'GET', '/api/v1/hello')).status).toBe(401);
    expect((await call(server, ann, 'GET', '/api/v1/items')).status).toBe(401);
    const bobs = await call(server, bob, 'GET', `/api/v1/items/${id}`);
    expect(await bobs.text()).toBe('for bob');
    // signing up again starts empty
    expect((await signUp(server, ann)).status).toBe(200);
    const list = await call(server, ann, 'GET', '/api/v1/items');
    expect(await list.json()).toEqual({ items: [] });
    expect(await (await put(server, ann, id, 'new')).json()).toEqual({
      rev: 1,
    });
  });

  it('still has the items and revs after a restart', async () => {
    const first = await start();
    const who = await join(first);
    const [a, b] = [itemId('m'), itemId('r')];
    await put(first, who, a, 'shelf');
    await put(first, who, b, 'piece');
    await put(first, who, a, 'shelf again');
    await first.close();

    const second = await start({ dataDir: first.dataDir });
    const list = await call(second, who, 'GET', '/api/v1/items');
    expect(await list.json()).toMatchObject({
      items: [
        { id: b, rev: 2, size: 5 },
        { id: a, rev: 3, size: 11 },
      ],
    });
    const got = await call(second, who, 'GET', `/api/v1/items/${a}`);
    expect(await got.text()).toBe('shelf again');
    expect(got.headers.get('etag')).toBe('"3"');
    const stale = await put(second, who, a, 'x', { 'If-Match': '"1"' });
    expect(stale.status).toBe(412);
    expect(await (await put(second, who, b, 'next')).json()).toEqual({
      rev: 4,
    });
    expect((await signUp(second, who)).status).toBe(200);
    const other = await signUp(second, { ...who, token: someone().token });
    expect(other.status).toBe(409);
  });
});

describe('limits', () => {
  it('refuses an item over the size limit', async () => {
    const server = await start({ limits: { itemBytes: 100 } });
    const who = await join(server);
    const id = itemId();
    expect((await put(server, who, id, 'x'.repeat(100))).status).toBe(200);
    const over = await put(server, who, id, 'x'.repeat(101));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: 'too_large' });
    const got = await call(server, who, 'GET', `/api/v1/items/${id}`);
    expect((await got.text()).length).toBe(100);
  });

  it('stops reading a body without a length once it is over', async () => {
    const server = await start({ limits: { itemBytes: 100 } });
    const who = await join(server);
    const id = itemId();
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(60, 1));
    const res = await raw(
      server,
      'PUT',
      `/api/v1/items/${id}`,
      { Authorization: who.bearer },
      chunks,
    );
    expect(res.status).toBe(413);
    expect(res.headers.connection).toBe('close');
    expect((await call(server, who, 'GET', `/api/v1/items/${id}`)).status).toBe(
      404,
    );
  });

  it('refuses more items than an account may hold', async () => {
    const server = await start({ limits: { accountItems: 2 } });
    const who = await join(server);
    const [a, b, c] = [itemId(), itemId(), itemId()];
    await put(server, who, a, 'a');
    await put(server, who, b, 'b');
    const third = await put(server, who, c, 'c');
    expect(third.status).toBe(413);
    expect(await third.json()).toEqual({ error: 'account_full' });
    // an item it already holds can still change, and room comes back
    expect((await put(server, who, a, 'a again')).status).toBe(200);
    await call(server, who, 'DELETE', `/api/v1/items/${b}`);
    expect((await put(server, who, c, 'c')).status).toBe(200);
  });

  it('refuses more bytes than an account may hold', async () => {
    const server = await start({ limits: { accountBytes: 100 } });
    const who = await join(server);
    const [a, b] = [itemId(), itemId()];
    expect((await put(server, who, a, 'x'.repeat(60))).status).toBe(200);
    const over = await put(server, who, b, 'x'.repeat(41));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: 'account_full' });
    expect((await put(server, who, b, 'x'.repeat(40))).status).toBe(200);
    // replacing counts the item's new size, not both
    expect((await put(server, who, a, 'y'.repeat(60))).status).toBe(200);
    expect((await put(server, who, a, 'y'.repeat(61))).status).toBe(413);
  });

  it('refuses an account over its requests for the minute', async () => {
    const server = await start({ limits: { requestsPerMinute: 3 } });
    const [ann, bob] = [await join(server), await join(server)];
    const hello = (who: typeof ann) =>
      call(server, who, 'GET', '/api/v1/hello');
    for (let i = 0; i < 3; i++) expect((await hello(ann)).status).toBe(200);
    const over = await hello(ann);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: 'too_many_requests' });
    expect(over.headers.get('retry-after')).toBe('60');
    expect((await hello(bob)).status).toBe(200);
    server.advance(60_000);
    expect((await hello(ann)).status).toBe(200);
  });

  it('refuses an address after too many failed logins', async () => {
    const server = await start({ limits: { failuresPerMinute: 3 } });
    const who = await join(server);
    const stranger = someone();
    const hello = (as: typeof who, headers = {}) =>
      call(server, as, 'GET', '/api/v1/hello', undefined, headers);
    for (let i = 0; i < 3; i++)
      expect((await hello(stranger)).status).toBe(401);
    expect((await hello(stranger)).status).toBe(429);
    // the address is refused, whoever asks, and signing up too
    expect((await hello(who)).status).toBe(429);
    expect((await signUp(server, someone())).status).toBe(429);
    // another address is not
    const elsewhere = { 'CF-Connecting-IP': '203.0.113.7' };
    expect((await hello(who, elsewhere)).status).toBe(200);
    server.advance(60_000);
    expect((await hello(who)).status).toBe(200);
  });

  it('refuses an address after too many failed sign-ups', async () => {
    const server = await start({ limits: { failuresPerMinute: 2 } });
    const from = { 'CF-Connecting-IP': '203.0.113.9' };
    const who = someone();
    expect((await signUp(server, who, 'guess 1', from)).status).toBe(403);
    expect((await signUp(server, who, 'guess 2', from)).status).toBe(403);
    // even the right code is refused now
    expect((await signUp(server, who, INVITE, from)).status).toBe(429);
    expect((await signUp(server, who)).status).toBe(200);
    server.advance(60_000);
    expect((await signUp(server, who, INVITE, from)).status).toBe(200);
  });
});

describe('unknown API paths', () => {
  it('answers 404 as JSON, never the site', async () => {
    const publicDir = await tempDir();
    await fs.writeFile(path.join(publicDir, 'index.html'), '<p>site</p>');
    const server = await start({ publicDir });
    const who = await join(server);
    for (const pathname of [
      '/api',
      '/api/',
      '/api/v1',
      '/api/v2/hello',
      '/api/v1/readers/x',
      '/api/v1/items/',
      '/api/v1/nothing',
    ]) {
      const res = await call(server, who, 'GET', pathname);
      const expected = pathname === '/api/v1/items/' ? 400 : 404;
      expect(`${pathname} ${res.status}`).toBe(`${pathname} ${expected}`);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('the log', () => {
  it('has time, method, path without ids, status and bytes, and nothing else', async () => {
    const server = await start();
    const who = await join(server);
    const id = itemId();
    await put(server, who, id, 'secret text');
    await call(server, who, 'GET', `/api/v1/items/${id}`);
    await call(server, who, 'GET', `/api/v1/readers/${who.reader}`);
    await call(server, someone(), 'GET', '/api/v1/items');
    await call(server, who, 'DELETE', `/api/v1/items/${id}`);
    await fetch(`${server.url}/health?x=${who.token}`);
    const at = '2026-11-11T10:00:00.000Z';
    expect(server.logs).toEqual([
      `${at} POST /api/v1/readers 200 16`,
      `${at} PUT /api/v1/items/:id 200 9`,
      `${at} GET /api/v1/items/:id 200 11`,
      `${at} GET /api/:unknown 404 21`,
      `${at} GET /api/v1/items 401 24`,
      `${at} DELETE /api/v1/items/:id 204 0`,
      `${at} GET /health 200 2`,
    ]);
    const all = server.logs.join('\n');
    for (const secret of [who.reader, who.token, id, 'secret text', 'Bearer'])
      expect(all).not.toContain(secret);
  });
});
