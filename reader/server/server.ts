import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { json, notAllowed, refuse, SECURITY_HEADERS } from './reply';
import type { Reply } from './reply';
import { serveSite } from './site';
import { Store, type Account } from './store';

export type Limits = {
  /** Bytes in one item. */
  itemBytes: number;
  /** Items in one account. */
  accountItems: number;
  /** Bytes in one account, all items together. */
  accountBytes: number;
  /** Requests a minute for one account. */
  requestsPerMinute: number;
  /** Refused logins and sign-ups a minute from one address. */
  failuresPerMinute: number;
};

export const DEFAULT_LIMITS: Limits = {
  itemBytes: 1024 * 1024,
  accountItems: 2000,
  accountBytes: 200 * 1024 * 1024,
  requestsPerMinute: 1200,
  failuresPerMinute: 20,
};

export type ReaderServerOptions = {
  dataDir: string;
  publicDir: string;
  /** The invitation code; empty means nobody can sign up. */
  invite: string;
  limits?: Partial<Limits>;
  now?: () => Date;
  log?: (line: string) => void;
};

// These patterns are also the path-traversal guard: an id that matches is
// safe as a folder or file name, and nothing else reaches the disk.
const READER_ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ITEM_ID = /^[a-z]-[0-9a-f]{32}$/;
const BEARER = /^Bearer ([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

const ITEMS = '/api/v1/items/';
const SIGN_UP_BYTES = 4096;
const MINUTE_MS = 60_000;

type Handler = (req: http.IncomingMessage) => Promise<Reply>;
type Routed = { label: string; reply: Reply };

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

/** Counts per key in the current minute. */
class MinuteCounter {
  private readonly seen = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => Date) {}

  count(key: string): number {
    const entry = this.seen.get(key);
    if (!entry) return 0;
    return this.now().getTime() - entry.start < MINUTE_MS ? entry.count : 0;
  }

  add(key: string): number {
    const count = this.count(key) + 1;
    const start =
      count === 1 ? this.now().getTime() : this.seen.get(key)!.start;
    this.seen.set(key, { start, count });
    if (this.seen.size > 10_000) this.prune();
    return count;
  }

  private prune(): void {
    for (const key of this.seen.keys())
      if (this.count(key) === 0) this.seen.delete(key);
  }
}

function addressOf(req: http.IncomingMessage): string {
  const forwarded = req.headers['cf-connecting-ip'];
  if (typeof forwarded === 'string' && forwarded) return forwarded;
  return req.socket.remoteAddress ?? 'unknown';
}

/** Reads the body up to `max` bytes; null when it is larger. */
function readBody(
  req: http.IncomingMessage,
  max: number,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > max) return resolve(null);
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= max) return void chunks.push(chunk);
      req.off('data', onData);
      req.pause();
      resolve(null);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('close', () => reject(new Error('aborted')));
  });
}

type Precondition = (rev: number | undefined) => boolean;

/**
 * What `If-Match` and `If-None-Match` ask of the stored revision; null for a
 * value this server does not know (anything but `"<rev>"` and `*`).
 */
function precondition(req: http.IncomingMessage): Precondition | null {
  const match = req.headers['if-match'];
  const none = req.headers['if-none-match'];
  if (none !== undefined && none !== '*') return null;
  if (match !== undefined && match !== '*' && !/^"\d+"$/.test(match))
    return null;
  return (rev) => {
    if (none !== undefined && rev !== undefined) return false;
    if (match === undefined) return true;
    return rev !== undefined && (match === '*' || match === `"${rev}"`);
  };
}

const tooLarge = () => refuse(413, 'too_large', { Connection: 'close' });
const tooMany = () => refuse(429, 'too_many_requests', { 'Retry-After': '60' });
const unauthorized = () =>
  refuse(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
const notFound = () => refuse(404, 'not_found');

/**
 * The reader server: accounts and opaque items under `/api/v1`, the site for
 * everything else. Not yet listening.
 */
export function createReaderServer(opts: ReaderServerOptions): http.Server {
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => undefined);
  const store = new Store(opts.dataDir);
  const failures = new MinuteCounter(now);
  const requests = new MinuteCounter(now);
  const invite = opts.invite ? sha256(opts.invite) : null;

  const blocked = (address: string) =>
    failures.count(address) >= limits.failuresPerMinute;

  /** The reader id the bearer proves, or the refusal. */
  async function signIn(req: http.IncomingMessage): Promise<string | Reply> {
    const address = addressOf(req);
    if (blocked(address)) return tooMany();
    const bearer = BEARER.exec(req.headers.authorization ?? '');
    const reader = bearer?.[1];
    const account = reader
      ? await store.exclusive(reader, () => store.find(reader))
      : null;
    // An unknown account is compared too, so it takes as long as a wrong token.
    const stored = Buffer.from(account?.tokenHash ?? '', 'hex');
    const given = sha256(bearer?.[2] ?? '');
    const known = stored.length === given.length ? stored : Buffer.alloc(32);
    if (!timingSafeEqual(known, given) || !reader || !account) {
      failures.add(address);
      return unauthorized();
    }
    if (requests.add(reader) > limits.requestsPerMinute) return tooMany();
    return reader;
  }

  /** Runs `work` alone for this account; the account may be gone by then. */
  function withAccount(
    reader: string,
    work: (account: Account) => Promise<Reply>,
  ): Promise<Reply> {
    return store.exclusive(reader, async () => {
      const account = await store.find(reader);
      return account ? work(account) : unauthorized();
    });
  }

  /** A handler that runs for a signed-in reader, alone for its account. */
  function forReader(
    work: (reader: string, account: Account) => Promise<Reply>,
  ): Handler {
    return async (req) => {
      const reader = await signIn(req);
      if (typeof reader !== 'string') return reader;
      return withAccount(reader, (account) => work(reader, account));
    };
  }

  async function signUp(req: http.IncomingMessage): Promise<Reply> {
    const address = addressOf(req);
    if (blocked(address)) return tooMany();
    const raw = await readBody(req, SIGN_UP_BYTES);
    if (!raw) return tooLarge();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString('utf8')) ?? {};
    } catch {
      return refuse(400, 'bad_request');
    }
    const given = typeof body.invite === 'string' ? body.invite : '';
    if (!invite || !timingSafeEqual(sha256(given), invite)) {
      failures.add(address);
      return refuse(403, 'forbidden');
    }
    const { reader, token } = body;
    if (typeof reader !== 'string' || !READER_ID.test(reader))
      return refuse(400, 'bad_request');
    if (typeof token !== 'string' || !TOKEN.test(token))
      return refuse(400, 'bad_request');
    const hash = sha256(token);
    const outcome = await store.exclusive(reader, async () => {
      const account = await store.find(reader);
      if (!account) {
        await store.create(reader, hash.toString('hex'), now().toISOString());
        return 'created';
      }
      const stored = Buffer.from(account.tokenHash, 'hex');
      const same = stored.length === hash.length;
      return same && timingSafeEqual(stored, hash) ? 'exists' : 'conflict';
    });
    if (outcome === 'conflict') {
      failures.add(address);
      return refuse(409, 'conflict');
    }
    return json(200, { created: outcome === 'created' });
  }

  const hello = forReader(async () =>
    json(200, { server: 'shellie-reader', v: 1 }),
  );

  const removeReader = forReader(async (reader) => {
    await store.remove(reader);
    return { status: 204 };
  });

  const listItems = forReader(async (_reader, account) => {
    const items = Object.entries(account.items)
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((a, b) => a.rev - b.rev);
    return json(200, { items });
  });

  const getItem = (id: string) =>
    forReader(async (reader, account) => {
      const entry = account.items[id];
      const bytes = entry ? await store.readItem(reader, id) : null;
      if (!entry || !bytes) return notFound();
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          ETag: `"${entry.rev}"`,
        },
        body: bytes,
      };
    });

  const deleteItem = (id: string) =>
    forReader(async (reader, account) => {
      if (!account.items[id]) return notFound();
      await store.deleteItem(reader, account, id);
      return { status: 204 };
    });

  /** The refusal when these bytes would take the account over a limit. */
  function overQuota(account: Account, id: string, size: number): Reply | null {
    const entries = Object.values(account.items);
    const current = account.items[id];
    if (!current && entries.length >= limits.accountItems)
      return refuse(413, 'account_full');
    const stored = entries.reduce((sum, entry) => sum + entry.size, 0);
    return stored - (current?.size ?? 0) + size > limits.accountBytes
      ? refuse(413, 'account_full')
      : null;
  }

  // Not `forReader`: the body is read between signing in and taking the
  // account's turn, so a slow upload holds nothing up.
  const putItem =
    (id: string): Handler =>
    async (req) => {
      const reader = await signIn(req);
      if (typeof reader !== 'string') return reader;
      const holds = precondition(req);
      if (!holds) return refuse(400, 'bad_request');
      const bytes = await readBody(req, limits.itemBytes);
      if (!bytes) return tooLarge();
      return withAccount(reader, async (account) => {
        if (!holds(account.items[id]?.rev))
          return refuse(412, 'precondition_failed');
        const full = overQuota(account, id, bytes.length);
        if (full) return full;
        const at = now().toISOString();
        const rev = await store.putItem(reader, account, id, bytes, at);
        return json(200, { rev }, { ETag: `"${rev}"` });
      });
    };

  const routes: Record<string, Record<string, Handler>> = {
    '/api/v1/readers': { POST: signUp },
    '/api/v1/hello': { GET: hello },
    '/api/v1/reader': { DELETE: removeReader },
    '/api/v1/items': { GET: listItems },
  };

  async function item(
    req: http.IncomingMessage,
    method: string,
    id: string,
  ): Promise<Reply> {
    const handlers: Record<string, (id: string) => Handler> = {
      GET: getItem,
      PUT: putItem,
      DELETE: deleteItem,
    };
    const handler = handlers[method];
    if (!handler) return notAllowed(Object.keys(handlers));
    if (!ITEM_ID.test(id)) return refuse(400, 'bad_request');
    return handler(id)(req);
  }

  async function api(
    req: http.IncomingMessage,
    method: string,
    pathname: string,
  ): Promise<Routed> {
    if (pathname.startsWith(ITEMS)) {
      const id = pathname.slice(ITEMS.length);
      return { label: `${ITEMS}:id`, reply: await item(req, method, id) };
    }
    const handlers = routes[pathname];
    // The label is fixed: a wrong path could hold an id.
    if (!handlers) return { label: '/api/:unknown', reply: notFound() };
    const handler = handlers[method];
    const reply = handler
      ? await handler(req)
      : notAllowed(Object.keys(handlers));
    return { label: pathname, reply };
  }

  function health(method: string): Reply {
    if (method !== 'GET' && method !== 'HEAD')
      return notAllowed(['GET', 'HEAD']);
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body: 'ok',
    };
  }

  // The path as sent, not normalised: `..` must reach the guards as it came.
  async function route(req: http.IncomingMessage): Promise<Routed> {
    const method = req.method ?? 'GET';
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/health')
      return { label: pathname, reply: health(method) };
    if (pathname === '/api' || pathname.startsWith('/api/'))
      return api(req, method, pathname);
    const reply = await serveSite(opts.publicDir, method, pathname);
    return { label: pathname.slice(0, 200), reply };
  }

  function send(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    { label, reply }: Routed,
  ): void {
    const body = Buffer.from(reply.body ?? '');
    const bodiless = reply.status === 204 || reply.status === 304;
    const sent = req.method === 'HEAD' || bodiless ? 0 : body.length;
    res.writeHead(reply.status, {
      ...SECURITY_HEADERS,
      ...reply.headers,
      ...(bodiless ? {} : { 'Content-Length': String(body.length) }),
    });
    res.end(sent ? body : undefined);
    // Never a header, a body, a reader id or a token.
    log(
      `${now().toISOString()} ${req.method} ${label} ${reply.status} ${sent}`,
    );
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let routed: Routed;
    try {
      routed = await route(req);
    } catch (err) {
      if (req.destroyed) return;
      // Only the error's code: a file error's message holds the reader id.
      const code = (err as NodeJS.ErrnoException).code ?? 'error';
      log(`${now().toISOString()} failed ${code}`);
      routed = { label: '-', reply: refuse(500, 'server_error') };
    }
    send(req, res, routed);
  }

  const server = http.createServer((req, res) => void handle(req, res));
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  return server;
}
