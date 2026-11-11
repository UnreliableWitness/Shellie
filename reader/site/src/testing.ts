import {
  b64url,
  itemId,
  itemName,
  readerKeys,
  seal,
  type ReaderKeys,
  type ReaderLetter,
  type ReaderMarkSet,
  type ReaderPiece,
  type ReaderRead,
  type ReaderShelf,
} from '../../../src/shared/reader';

// For the site's tests only: a reader server in memory behind a `fetch`, and a made-up brain (a bakery's ordering).

export const SECRET = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
export const LINK = `https://reader.example/#${b64url(SECRET)}`;
export const BRAIN = 'brain-bakery';

type Stored = { rev: number; bytes: Uint8Array<ArrayBuffer> };
export type Call = { method: string; path: string; headers: Headers };

export type FakeServer = {
  keys: ReaderKeys;
  fetcher: typeof fetch;
  items: Map<string, Stored>;
  calls: Call[];
  /** `offline`: every call fails without an answer. A number: every call answers that status. */
  mode: 'ok' | 'offline' | number;
  /** Runs once, before the next PUT is looked at: another device writing first. */
  beforePut: (() => Promise<void>) | null;
  /** Seals a value and stores it, as Shellie's push does. */
  put(id: string, value: unknown): Promise<void>;
  id(kind: 'm' | 'r' | 'p' | 'k', path?: string): Promise<string>;
  /** The calls of one kind, as `GET r` or `PUT k` (the method and the item's kind letter), or `GET list`. */
  count(what: string): number;
};

const json = (status: number, value: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

export async function fakeServer(secret = SECRET): Promise<FakeServer> {
  const keys = await readerKeys(secret);
  const items = new Map<string, Stored>();
  const calls: Call[] = [];
  let counter = 0;
  const store = (id: string, bytes: Uint8Array<ArrayBuffer>) => {
    const rev = ++counter;
    items.set(id, { rev, bytes });
    return rev;
  };
  const server: FakeServer = {
    keys,
    items,
    calls,
    mode: 'ok',
    beforePut: null,
    put: async (id, value) => void store(id, await seal(keys, id, value)),
    id: (kind, path) => itemId(keys, kind, itemName(BRAIN, path)),
    count: (what) =>
      calls.filter((c) => {
        const id = c.path.split('/items/')[1];
        return `${c.method} ${id ? id[0] : 'list'}` === what;
      }).length,
    fetcher: async (input, init = {}) => {
      const path = String(input);
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      calls.push({ method, path, headers });
      if (server.mode === 'offline') throw new TypeError('Failed to fetch');
      if (typeof server.mode === 'number')
        return json(server.mode, { error: 'refused' });
      if (
        headers.get('Authorization') !== `Bearer ${keys.reader}.${keys.token}`
      )
        return json(401, { error: 'unauthorized' });
      if (path === '/api/v1/items')
        return json(200, {
          items: [...items]
            .map(([id, { rev, bytes }]) => ({
              id,
              rev,
              size: bytes.length,
              at: '2026-11-11T10:00:00.000Z',
            }))
            .sort((a, b) => a.rev - b.rev),
        });
      const id = path.split('/api/v1/items/')[1];
      if (!id) return json(404, { error: 'not_found' });
      const item = items.get(id);
      if (method === 'GET') {
        if (!item) return json(404, { error: 'not_found' });
        return new Response(item.bytes, {
          status: 200,
          headers: { ETag: `"${item.rev}"` },
        });
      }
      if (method === 'PUT') {
        const before = server.beforePut;
        server.beforePut = null;
        await before?.();
        const now = items.get(id);
        const match = headers.get('If-Match');
        const refused =
          (headers.get('If-None-Match') === '*' && now) ||
          (match !== null && match !== `"${now?.rev}"`);
        if (refused) return json(412, { error: 'precondition_failed' });
        const rev = store(id, new Uint8Array(init.body as Uint8Array));
        return json(200, { rev }, { ETag: `"${rev}"` });
      }
      return json(405, { error: 'method_not_allowed' });
    },
  };
  return server;
}

const read = (
  id: string,
  path: string,
  title: string,
  rest: Partial<ReaderRead>,
): ReaderRead => ({
  id,
  path,
  title,
  summary: '',
  chapter: null,
  topic: null,
  written: '2026-11-03',
  minutes: 8,
  hash: `hash-${path}`,
  stale: false,
  ...rest,
});

export const PATHS = {
  order: 'reads/how-an-order-is-taken.md',
  plan: 'reads/the-baking-plan.md',
  rounds: 'reads/delivery-rounds.md',
  prices: 'reads/price-list.md',
  standing: 'reads/standing-orders.md',
  letter: 'reads/letters/2026-11-09-rounds-leave-earlier.md',
  sheet: 'wiki/order-sheet.md',
  oven: 'wiki/oven-schedule.md',
} as const;

export const PLAN_TEXT = `# The baking plan

Every evening the bakery turns the day's orders into one plan for the night. The plan starts from the
[order sheet](../wiki/order-sheet.md#cut-off-time), not from the till.

![The plan on the wall](../raw/plan.png)

> **Before you read on**
> An order comes in after the plan was made. What should happen to it?
>
> **Answer**
> It goes on tomorrow's sheet, unless the baker on duty adds it by hand.

The [supplier list](../wiki/suppliers.md) decides what can be baked at all, and the
[miller's site](https://example.com/mill) says when flour arrives. Deliveries are told in
[the delivery rounds](delivery-rounds.md).

## One night, three batches

Bread first, then rolls, then pastry.

## What the writer was missing

- Nobody said who may change the plan after midnight.
`;

export const LETTER_TEXT = `# The rounds leave earlier

The second round moved, and with it the last moment for a late order.

## What you read

The second round leaves at seven.

## What holds now

The second round leaves at half past six.

## Why it changed

The school canteen opens earlier since November.

## What follows

A late order has to be packed by six.
`;

export const SHEET_TEXT = `# Order sheet

One sheet per day, kept at the counter.

## Cut-off time

Orders for tomorrow close at four. See the [oven schedule](oven-schedule.md).
`;

/**
 * The bakery brain on the server: five long reads (one read, one changed with a letter, one changed without, one
 * on a topic), a letter, two cited pages, and the marks that make it so.
 */
export async function seedBakery(server: FakeServer): Promise<{
  shelf: ReaderShelf;
  marks: ReaderMarkSet;
}> {
  const ids = {
    order: await server.id('r', PATHS.order),
    plan: await server.id('r', PATHS.plan),
    rounds: await server.id('r', PATHS.rounds),
    prices: await server.id('r', PATHS.prices),
    standing: await server.id('r', PATHS.standing),
    letter: await server.id('r', PATHS.letter),
    sheet: await server.id('p', PATHS.sheet),
    oven: await server.id('p', PATHS.oven),
  };
  const letter: ReaderLetter = {
    id: ids.letter,
    path: PATHS.letter,
    title: 'The rounds leave earlier',
    read: PATHS.rounds,
    written: '2026-11-09',
    minutes: 3,
    hash: 'hash-letter',
  };
  const shelf: ReaderShelf = {
    v: 1,
    brainId: BRAIN,
    name: 'Corner Bakery',
    sentAt: '2026-11-11T09:00:00.000Z',
    chapters: ['Orders', 'Baking', 'Delivery'],
    reads: [
      read(ids.order, PATHS.order, 'How an order is taken', {
        chapter: 'Orders',
        summary: 'From the phone call to the order sheet.',
      }),
      read(ids.plan, PATHS.plan, 'The baking plan', {
        chapter: 'Baking',
        summary: 'How a day of orders becomes one night of baking.',
        minutes: 11,
        stale: true,
      }),
      read(ids.rounds, PATHS.rounds, 'The delivery rounds', {
        chapter: 'Delivery',
        summary: 'Two rounds a morning and who is on which.',
        hash: 'hash-rounds-2',
      }),
      read(ids.prices, PATHS.prices, 'Where a price comes from', {
        chapter: 'Orders',
        summary: 'The price list and its three exceptions.',
        hash: 'hash-prices-2',
      }),
      read(ids.standing, PATHS.standing, 'Standing orders', {
        topic: 'standing orders',
        summary: 'Orders that repeat every week.',
        minutes: 6,
      }),
    ],
    letters: [letter],
    refs: {
      [PATHS.sheet]: { id: ids.sheet, title: 'Order sheet' },
      [PATHS.oven]: { id: ids.oven, title: 'Oven schedule' },
    },
  };
  const at = '2026-11-05T08:00:00.000Z';
  const marks: ReaderMarkSet = {
    [PATHS.order]: { hash: `hash-${PATHS.order}`, at, read: true },
    // Read before they changed: the rounds have a letter since, the prices have none.
    [PATHS.rounds]: { hash: 'hash-rounds-1', at, read: true },
    [PATHS.prices]: { hash: 'hash-prices-1', at, read: true },
  };
  const piece = (path: string, title: string, text: string): ReaderPiece => ({
    v: 1,
    path,
    title,
    text,
  });
  await server.put(
    ids.order,
    piece(PATHS.order, 'How an order is taken', 'An order starts with a call.'),
  );
  await server.put(ids.plan, piece(PATHS.plan, 'The baking plan', PLAN_TEXT));
  await server.put(
    ids.rounds,
    piece(
      PATHS.rounds,
      'The delivery rounds',
      'Two rounds leave each morning.',
    ),
  );
  await server.put(
    ids.prices,
    piece(PATHS.prices, 'Where a price comes from', 'A price is on the list.'),
  );
  await server.put(
    ids.standing,
    piece(PATHS.standing, 'Standing orders', 'Some orders repeat.'),
  );
  await server.put(ids.letter, piece(PATHS.letter, letter.title, LETTER_TEXT));
  await server.put(ids.sheet, piece(PATHS.sheet, 'Order sheet', SHEET_TEXT));
  await server.put(
    ids.oven,
    piece(
      PATHS.oven,
      'Oven schedule',
      '# Oven schedule\n\nThe oven is lit at two.',
    ),
  );
  await server.put(await server.id('k'), { v: 1, marks });
  await server.put(await server.id('m'), shelf);
  return { shelf, marks };
}
