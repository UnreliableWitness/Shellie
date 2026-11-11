import { z } from 'zod';
import { READER_SERVER } from '../../shared/reader';

export type ReaderErrorKind =
  /** No answer: no network, a timeout, or a redirect. */
  | 'network'
  /** The server does not know this account or its token. */
  | 'auth'
  /** The invitation code is wrong, or the server takes no sign-ups. */
  | 'invite'
  /** Someone else wrote the item first. */
  | 'conflict'
  /** Too many requests in a minute: the rest waits. */
  | 'busy'
  /** The item or the account is over the server's limits. */
  | 'full'
  | 'server'
  | 'rejected';

const MESSAGES: Record<ReaderErrorKind, string> = {
  network: 'The reader server could not be reached',
  auth: 'The reader server no longer knows this connection',
  invite: 'The reader server refused the invitation code',
  conflict: 'The reader server has a newer version',
  busy: 'The reader server asked to slow down; the rest goes with the next push',
  full: 'The reader server has no room left for this account',
  server: 'The reader server answered with an error',
  rejected: 'This address did not answer like a reader server',
};

/** A failed call. The message never contains the address, an id or the server's text. */
export class ReaderError extends Error {
  constructor(
    readonly kind: ReaderErrorKind,
    readonly status?: number,
  ) {
    super(MESSAGES[kind]);
    this.name = 'ReaderError';
  }
}
export const readerErrorKind = (err: unknown): ReaderErrorKind =>
  err instanceof ReaderError ? err.kind : 'network';

const TIMEOUT_MS = 15_000;

/** The server's address and the `Authorization: Bearer` value (`bearer(keys)`). */
export type ReaderConn = { url: string; bearer: string };

type Init = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string | Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
  bearer?: string;
};

async function call(
  url: string,
  path: string,
  init: Init,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(`${url}${path}`, {
        method: init.method,
        body: init.body,
        signal: ctl.signal,
        // The token must never follow a redirect to another address.
        redirect: 'error',
        headers: {
          ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new ReaderError('network');
    }
    if (res.status === 401) throw new ReaderError('auth', 401);
    if (res.status === 412) throw new ReaderError('conflict', 412);
    if (res.status === 413) throw new ReaderError('full', 413);
    if (res.status === 429) throw new ReaderError('busy', 429);
    if (res.status >= 500) throw new ReaderError('server', res.status);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function jsonOf<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ReaderError('rejected', res.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ReaderError('rejected', res.status);
  return parsed.data;
}

const ok = (res: Response): Response => {
  if (!res.ok) throw new ReaderError('rejected', res.status);
  return res;
};

/** Makes the account; the same account with the same token is fine. */
export async function signUp(
  url: string,
  account: { reader: string; token: string; invite: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await call(
    url,
    '/api/v1/readers',
    {
      method: 'POST',
      body: JSON.stringify(account),
      headers: { 'Content-Type': 'application/json' },
    },
    fetchImpl,
  );
  if (res.status === 403) throw new ReaderError('invite', 403);
  await jsonOf(ok(res), z.object({ created: z.boolean() }));
}

const HelloSchema = z.object({
  server: z.literal(READER_SERVER),
  v: z.number(),
});

/** Asks the server whether it is a reader server that knows this account. */
export async function hello(
  c: ReaderConn,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await call(
    c.url,
    '/api/v1/hello',
    { method: 'GET', bearer: c.bearer },
    fetchImpl,
  );
  await jsonOf(ok(res), HelloSchema);
}

/** Removes the account and everything in it. */
export async function removeAccount(
  c: ReaderConn,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  ok(
    await call(
      c.url,
      '/api/v1/reader',
      { method: 'DELETE', bearer: c.bearer },
      fetchImpl,
    ),
  );
}

const ListSchema = z.object({
  items: z.array(
    z.object({ id: z.string(), rev: z.number(), size: z.number() }),
  ),
});

/** Every item of the account: id to its revision. */
export async function listItems(
  c: ReaderConn,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, number>> {
  const res = await call(
    c.url,
    '/api/v1/items',
    { method: 'GET', bearer: c.bearer },
    fetchImpl,
  );
  const { items } = await jsonOf(ok(res), ListSchema);
  return new Map(items.map((i) => [i.id, i.rev]));
}

const revOf = (etag: string | null): number | null => {
  const m = /^"(\d+)"$/.exec(etag ?? '');
  return m ? Number(m[1]) : null;
};

/** An item's bytes and revision; null when the server has none. */
export async function getItem(
  c: ReaderConn,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; rev: number } | null> {
  const res = await call(
    c.url,
    `/api/v1/items/${id}`,
    { method: 'GET', bearer: c.bearer },
    fetchImpl,
  );
  if (res.status === 404) return null;
  const rev = revOf(ok(res).headers.get('etag'));
  if (rev === null) throw new ReaderError('rejected', res.status);
  try {
    return { bytes: new Uint8Array(await res.arrayBuffer()), rev };
  } catch {
    throw new ReaderError('network');
  }
}

/**
 * Writes an item and returns its new revision. `only`: a revision it must still have, or `'new'` when there must be
 * none; otherwise whatever is there is replaced. A `conflict` error says someone else wrote first.
 */
export async function putItem(
  c: ReaderConn,
  id: string,
  bytes: Uint8Array<ArrayBuffer>,
  only?: number | 'new',
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const res = await call(
    c.url,
    `/api/v1/items/${id}`,
    {
      method: 'PUT',
      body: bytes,
      bearer: c.bearer,
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(only === 'new'
          ? { 'If-None-Match': '*' }
          : only !== undefined
            ? { 'If-Match': `"${only}"` }
            : {}),
      },
    },
    fetchImpl,
  );
  return (await jsonOf(ok(res), z.object({ rev: z.number() }))).rev;
}

/** Removes an item; one that is already gone is fine. */
export async function deleteItem(
  c: ReaderConn,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await call(
    c.url,
    `/api/v1/items/${id}`,
    { method: 'DELETE', bearer: c.bearer },
    fetchImpl,
  );
  if (res.status !== 404) ok(res);
}
