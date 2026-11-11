import { bearer, type ReaderKeys } from '../../../src/shared/reader';

/**
 * The reader server's API as the site uses it: the list of items, an item's bytes, and writing one (the marks).
 * Same origin only. Design: docs/superpowers/specs/2026-11-11-phone-reader-design.md, "The server".
 */

/**
 * Why a call failed:
 * - `gone`: the server does not know this account or its token any more;
 * - `offline`: no answer at all;
 * - `later`: over the server's rate limit, try at the next sync;
 * - `missing`: no such item;
 * - `conflict`: someone else wrote the item first (412);
 * - `other`: anything else.
 */
export type ApiFailure =
  | 'gone'
  | 'offline'
  | 'later'
  | 'missing'
  | 'conflict'
  | 'other';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiFailure,
    readonly status: number | null = null,
  ) {
    // Never a path or an id: the message may end up on screen or in a console.
    super(`reader server: ${kind}${status === null ? '' : ` (${status})`}`);
    this.name = 'ApiError';
  }
}

export const failureOf = (err: unknown): ApiFailure =>
  err instanceof ApiError ? err.kind : 'other';

export type ListedItem = { id: string; rev: number };
export type FetchedItem = { rev: number; bytes: Uint8Array<ArrayBuffer> };

export type ReaderApi = {
  list(): Promise<ListedItem[]>;
  get(id: string): Promise<FetchedItem>;
  /** Writes over revision `rev`, or only when there is no such item yet (`rev` null). Answers the new revision. */
  put(id: string, bytes: Uint8Array, rev: number | null): Promise<number>;
};

const ITEMS = '/api/v1/items';

function failure(status: number, account: boolean): ApiFailure {
  if (status === 401 || status === 403) return 'gone';
  if (status === 404) return account ? 'gone' : 'missing';
  if (status === 412) return 'conflict';
  if (status === 429) return 'later';
  return 'other';
}

const isItem = (v: unknown): v is ListedItem =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as ListedItem).id === 'string' &&
  typeof (v as ListedItem).rev === 'number';

/** `ETag: "<rev>"` as a number. */
function revOf(response: Response): number {
  const m = /^"(\d+)"$/.exec(response.headers.get('ETag') ?? '');
  if (!m) throw new ApiError('other', response.status);
  return Number(m[1]);
}

export function createApi(
  keys: Pick<ReaderKeys, 'reader' | 'token'>,
  fetcher: typeof fetch = (...args) => fetch(...args),
): ReaderApi {
  const authorization = `Bearer ${bearer(keys)}`;

  /** `account`: the call names no item, so a 404 says the account is gone. */
  async function call(
    path: string,
    account: boolean,
    init: RequestInit = {},
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetcher(path, {
        ...init,
        headers: { ...init.headers, Authorization: authorization },
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new ApiError('offline');
    }
    if (!response.ok)
      throw new ApiError(failure(response.status, account), response.status);
    return response;
  }

  /** A body that does not arrive whole is a lost connection too. */
  async function body<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch {
      throw new ApiError('offline');
    }
  }

  return {
    async list() {
      const response = await call(ITEMS, true);
      const value = await body<unknown>(() => response.json());
      const items = (value as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) throw new ApiError('other', response.status);
      return items.filter(isItem).map(({ id, rev }) => ({ id, rev }));
    },
    async get(id) {
      const response = await call(`${ITEMS}/${id}`, false);
      const rev = revOf(response);
      const bytes = await body(() => response.arrayBuffer());
      return { rev, bytes: new Uint8Array(bytes) };
    },
    async put(id, bytes, rev) {
      const response = await call(`${ITEMS}/${id}`, false, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(rev === null
            ? { 'If-None-Match': '*' }
            : { 'If-Match': `"${rev}"` }),
        },
        body: new Uint8Array(bytes),
      });
      const value = await body<unknown>(() => response.json());
      const next = (value as { rev?: unknown } | null)?.rev;
      if (typeof next !== 'number')
        throw new ApiError('other', response.status);
      return next;
    },
  };
}
