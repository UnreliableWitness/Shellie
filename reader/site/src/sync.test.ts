import { beforeEach, describe, expect, it } from 'vitest';
import {
  isMarkedRead,
  newSecret,
  readerKeys,
  ReaderMarksSchema,
  seal,
  unseal,
  type ReaderMarkSet,
} from '../../../src/shared/reader';
import { createApi } from './api';
import { memoryStore, type ItemStore } from './cache';
import { Reader } from './sync';
import {
  BRAIN,
  fakeServer,
  PATHS,
  seedBakery,
  type FakeServer,
} from './testing';

let server: FakeServer;
let store: ItemStore;
const reader = () =>
  new Reader(server.keys, createApi(server.keys, server.fetcher), store);

/** The marks as the server holds them. */
async function serverMarks(): Promise<ReaderMarkSet> {
  const id = await server.id('k');
  const value = await unseal(server.keys, id, server.items.get(id)!.bytes);
  return ReaderMarksSchema.parse(value).marks;
}

beforeEach(async () => {
  server = await fakeServer();
  store = memoryStore();
});

describe('sync', () => {
  it('opens the shelves, keeps every piece, and leaves alone what does not open', async () => {
    const { shelf, marks } = await seedBakery(server);
    // A shelf sealed with another key, and one that is no shelf.
    const other = await readerKeys(newSecret());
    const foreign = 'm-' + 'a'.repeat(32);
    server.items.set(foreign, {
      rev: 900,
      bytes: await seal(other, foreign, shelf),
    });
    await server.put('m-' + 'b'.repeat(32), { v: 2, hello: 'later' });

    const r = reader();
    await r.sync();
    const state = r.getState();
    expect(state.library?.shelves).toEqual([shelf]);
    expect(state.library?.marks[BRAIN]).toEqual(marks);
    expect(state).toMatchObject({ problem: null, gone: false, syncing: false });

    await r.settled();
    const kept = (await store.index()).map((item) => item.id).sort();
    expect(kept).toEqual([...server.items.keys()].sort());
    // Kept as the server has it: sealed.
    const plan = await store.get(await server.id('r', PATHS.plan));
    expect(new TextDecoder().decode(plan!.bytes)).not.toContain('bakery');
  });

  it('fetches only what is new or changed, and drops what the server no longer lists', async () => {
    await seedBakery(server);
    const r = reader();
    await r.sync();
    await r.settled();
    const before = server.calls.length;

    await r.sync();
    await r.settled();
    expect(server.calls.length - before).toBe(1);
    expect(server.calls.at(-1)?.path).toBe('/api/v1/items');

    const oven = await server.id('p', PATHS.oven);
    const standing = await server.id('r', PATHS.standing);
    server.items.delete(oven);
    await server.put(standing, {
      v: 1,
      path: PATHS.standing,
      title: 'Standing orders',
      text: 'Some orders repeat, and some stop.',
    });
    const gets = server.count('GET r');
    await r.sync();
    await r.settled();
    expect(server.count('GET r') - gets).toBe(1);
    expect(await store.get(oven)).toBeNull();
    expect((await r.piece(standing))?.text).toContain('and some stop');
  });

  it('drops a shelf, and its marks, when the brain is no longer sent', async () => {
    await seedBakery(server);
    const r = reader();
    await r.sync();
    await r.settled();
    server.items.clear();
    await r.sync();
    await r.settled();
    expect(r.getState().library).toEqual({ shelves: [], marks: {} });
    expect(await store.index()).toEqual([]);
  });

  it('says the phone is not connected when the server refuses the token', async () => {
    await seedBakery(server);
    server.mode = 401;
    const r = reader();
    await r.sync();
    expect(r.getState()).toMatchObject({ gone: true, library: null });
  });

  it('shows what was kept when there is no connection', async () => {
    const { shelf, marks } = await seedBakery(server);
    const first = reader();
    await first.sync();
    await first.settled();

    server.mode = 'offline';
    const r = reader();
    await r.open();
    await r.sync();
    expect(r.getState()).toMatchObject({ problem: 'offline', gone: false });
    expect(r.getState().library).toEqual({
      shelves: [shelf],
      marks: { [BRAIN]: marks },
    });
    expect((await r.piece(shelf.reads[1].id))?.title).toBe('The baking plan');
  });

  it('fetches a piece that is not kept yet when it is opened', async () => {
    const { shelf } = await seedBakery(server);
    const r = reader();
    const piece = await r.piece(shelf.reads[0].id);
    expect(piece?.text).toBe('An order starts with a call.');
    expect(await store.get(shelf.reads[0].id)).not.toBeNull();
    server.mode = 'offline';
    await expect(r.piece(shelf.reads[1].id)).rejects.toMatchObject({
      kind: 'offline',
    });
  });

  it('stops fetching quietly when the server says later', async () => {
    await seedBakery(server);
    const real = server.fetcher;
    const api = createApi(server.keys, async (input, init) => {
      if (String(input).includes('/items/r-'))
        return new Response('{"error":"too_many_requests"}', { status: 429 });
      return real(input, init);
    });
    const r = new Reader(server.keys, api, store);
    await r.sync();
    await r.settled();
    expect(r.getState()).toMatchObject({ problem: null, gone: false });
    // Three at a time, each stopped at its first refusal.
    expect(server.count('GET r')).toBe(0);
    expect(r.getState().library?.shelves).toHaveLength(1);
  });
});

describe('marks', () => {
  it('writes the first mark as a new item, and the next over its revision', async () => {
    const { shelf } = await seedBakery(server);
    server.items.delete(await server.id('k'));
    const r = reader();
    await r.sync();
    const plan = shelf.reads[1];

    await r.mark(BRAIN, plan, true);
    const puts = server.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe(`/api/v1/items/${await server.id('k')}`);
    expect(puts[0].headers.get('If-None-Match')).toBe('*');
    const marks = await serverMarks();
    expect(marks[plan.path]).toMatchObject({ hash: plan.hash, read: true });
    expect(isMarkedRead(r.getState().library!.marks[BRAIN], plan)).toBe(true);

    const rev = server.items.get(await server.id('k'))!.rev;
    await r.mark(BRAIN, plan, false);
    const second = server.calls.filter((c) => c.method === 'PUT')[1];
    expect(second.headers.get('If-Match')).toBe(`"${rev}"`);
    expect((await serverMarks())[plan.path].read).toBe(false);
    expect(isMarkedRead(r.getState().library!.marks[BRAIN], plan)).toBe(false);
  });

  it('merges and tries again when another device wrote first', async () => {
    const { shelf, marks } = await seedBakery(server);
    const r = reader();
    await r.sync();
    const [, plan, , , standing] = shelf.reads;
    const theirs = {
      hash: standing.hash,
      at: '2026-11-11T09:30:00.000Z',
      read: true,
    };
    server.beforePut = async () =>
      server.put(await server.id('k'), {
        v: 1,
        marks: { ...marks, [standing.path]: theirs },
      });

    await r.mark(BRAIN, plan, true);
    expect(server.count('PUT k')).toBe(2);
    const merged = await serverMarks();
    expect(merged[standing.path]).toEqual(theirs);
    expect(merged[plan.path]).toMatchObject({ hash: plan.hash, read: true });
    expect(merged[PATHS.order]).toEqual(marks[PATHS.order]);
    const shown = r.getState().library!.marks[BRAIN];
    expect(isMarkedRead(shown, plan)).toBe(true);
    expect(isMarkedRead(shown, standing)).toBe(true);
    expect(r.getState().problem).toBeNull();
  });

  it('gives up after three tries and sends the marks at the next sync', async () => {
    const { shelf, marks } = await seedBakery(server);
    const r = reader();
    await r.sync();
    const plan = shelf.reads[1];
    let n = 0;
    const meddle = async () => {
      n++;
      await server.put(await server.id('k'), {
        v: 1,
        marks: {
          ...marks,
          [PATHS.standing]: {
            hash: 'x',
            at: `2026-11-11T09:3${n}:00.000Z`,
            read: false,
          },
        },
      });
      if (n < 3) server.beforePut = meddle;
    };
    server.beforePut = meddle;
    await r.mark(BRAIN, plan, true);
    expect(server.count('PUT k')).toBe(3);
    expect((await serverMarks())[plan.path]).toBeUndefined();
    expect(isMarkedRead(r.getState().library!.marks[BRAIN], plan)).toBe(true);

    await r.sync();
    expect((await serverMarks())[plan.path]).toMatchObject({ read: true });
  });

  it('keeps a mark set without a connection and sends it at the next sync', async () => {
    const { shelf } = await seedBakery(server);
    const r = reader();
    await r.sync();
    await r.settled();
    const plan = shelf.reads[1];

    server.mode = 'offline';
    await r.mark(BRAIN, plan, true);
    expect(isMarkedRead(r.getState().library!.marks[BRAIN], plan)).toBe(true);
    expect(r.getState().problem).toBe('offline');
    const kept = await store.get(await server.id('k'));
    expect(kept?.toSend).toBe(true);
    expect(new TextDecoder().decode(kept!.bytes)).not.toContain('reads/');

    // The page is opened again later, still without a connection: the mark is there.
    const again = reader();
    await again.open();
    expect(isMarkedRead(again.getState().library!.marks[BRAIN], plan)).toBe(
      true,
    );

    // Meanwhile Shellie marked another piece.
    const theirs = { hash: 'h', at: '2026-11-11T09:40:00.000Z', read: true };
    await server.put(await server.id('k'), {
      v: 1,
      marks: { [PATHS.standing]: theirs },
    });
    server.mode = 'ok';
    await again.sync();
    const merged = await serverMarks();
    expect(merged[plan.path]).toMatchObject({ hash: plan.hash, read: true });
    expect(merged[PATHS.standing]).toEqual(theirs);
    expect((await store.get(await server.id('k')))?.toSend).toBeUndefined();
    expect(again.getState().problem).toBeNull();
  });

  it('lets a tap win over a mark from a clock that runs ahead', async () => {
    const { shelf } = await seedBakery(server);
    const plan = shelf.reads[1];
    const ahead = '2099-01-01T00:00:00.000Z';
    await server.put(await server.id('k'), {
      v: 1,
      marks: { [plan.path]: { hash: plan.hash, at: ahead, read: true } },
    });
    const r = reader();
    await r.sync();
    await r.mark(BRAIN, plan, false);
    const mark = (await serverMarks())[plan.path];
    expect(mark.read).toBe(false);
    expect(mark.at > ahead).toBe(true);
  });
});
