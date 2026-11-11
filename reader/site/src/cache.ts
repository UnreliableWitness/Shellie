/**
 * The items this phone keeps, as the server stores them: still sealed, by id, with the revision they were fetched
 * at. Kept in IndexedDB, so reading works without a connection; in memory when the browser has no IndexedDB (and
 * in the tests).
 */

export type KeptItem = {
  id: string;
  /** The server's revision of these bytes; 0 when the server never had them (marks set before the first send). */
  rev: number;
  bytes: Uint8Array<ArrayBuffer>;
  /** Marks set on this phone that still have to go to the server. */
  toSend?: boolean;
};

export type ItemStore = {
  /** Every kept item's id and revision, without reading its bytes. */
  index(): Promise<{ id: string; rev: number }[]>;
  get(id: string): Promise<KeptItem | null>;
  put(item: KeptItem): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
};

export function memoryStore(): ItemStore {
  const items = new Map<string, KeptItem>();
  return {
    index: async () => [...items.values()].map(({ id, rev }) => ({ id, rev })),
    get: async (id) => items.get(id) ?? null,
    put: async (item) => void items.set(item.id, { ...item }),
    delete: async (id) => void items.delete(id),
    clear: async () => items.clear(),
  };
}

const DB = 'shellie-reader';
const ITEMS = 'items';
// An index over the revision: walking its keys lists every item without loading the bytes.
const BY_REV = 'rev';

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
  });

function open(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB, 1);
  request.onupgradeneeded = () =>
    request.result
      .createObjectStore(ITEMS, { keyPath: 'id' })
      .createIndex(BY_REV, 'rev');
  return done(request);
}

export function idbStore(): ItemStore {
  let db: Promise<IDBDatabase> | null = null;
  const items = async (mode: IDBTransactionMode): Promise<IDBObjectStore> => {
    db ??= open();
    // A database that did not open is tried again at the next call.
    const opened = await db.catch((err: unknown) => {
      db = null;
      throw err;
    });
    return opened.transaction(ITEMS, mode).objectStore(ITEMS);
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    work: (items: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => done(work(await items(mode)));
  return {
    async index() {
      const request = (await items('readonly')).index(BY_REV).openKeyCursor();
      return new Promise((resolve, reject) => {
        const out: { id: string; rev: number }[] = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve(out);
          out.push({ id: String(cursor.primaryKey), rev: Number(cursor.key) });
          cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
      });
    },
    async get(id) {
      const item = await run<KeptItem | undefined>('readonly', (s) =>
        s.get(id),
      );
      return item ?? null;
    },
    put: async (item) => void (await run('readwrite', (s) => s.put(item))),
    delete: async (id) => void (await run('readwrite', (s) => s.delete(id))),
    clear: async () => void (await run('readwrite', (s) => s.clear())),
  };
}

/** IndexedDB when the browser has it, else memory: the site then works, but only with a connection. */
export function defaultStore(): ItemStore {
  return typeof indexedDB === 'undefined' ? memoryStore() : idbStore();
}
