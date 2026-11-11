import fs from 'node:fs/promises';
import path from 'node:path';

export type ItemEntry = { rev: number; size: number; at: string };

/** `reader.json`: all the server knows about an account. */
export type Account = {
  v: 1;
  tokenHash: string;
  created: string;
  /** The last revision handed out; an item's `rev` is the counter at its write. */
  counter: number;
  items: Record<string, ItemEntry>;
};

async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The accounts on disk: `<data>/readers/<reader id>/reader.json` and
 * `<data>/readers/<reader id>/items/<item id>`.
 *
 * Callers pass ids that already matched their pattern, and call everything but
 * `exclusive` from inside `exclusive` for that reader: the cached account and
 * its file then have one writer at a time.
 */
export class Store {
  private readonly accounts = new Map<string, Account>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly dataDir: string) {}

  /** Runs `work` after everything queued earlier for this reader. */
  exclusive<T>(reader: string, work: () => Promise<T>): Promise<T> {
    const before = this.chains.get(reader) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.catch(() => undefined);
    this.chains.set(reader, settled);
    void settled.then(() => {
      if (this.chains.get(reader) === settled) this.chains.delete(reader);
    });
    return run;
  }

  async find(reader: string): Promise<Account | null> {
    const cached = this.accounts.get(reader);
    if (cached) return cached;
    const raw = await readOrNull(this.accountFile(reader));
    if (!raw) return null;
    const account = JSON.parse(raw.toString('utf8')) as Account;
    this.accounts.set(reader, account);
    return account;
  }

  async create(reader: string, tokenHash: string, at: string): Promise<void> {
    await fs.mkdir(this.itemsDir(reader), { recursive: true, mode: 0o700 });
    await this.save(reader, {
      v: 1,
      tokenHash,
      created: at,
      counter: 0,
      items: {},
    });
  }

  async remove(reader: string): Promise<void> {
    this.accounts.delete(reader);
    await fs.rm(this.dir(reader), { recursive: true, force: true });
  }

  readItem(reader: string, id: string): Promise<Buffer | null> {
    return readOrNull(this.itemFile(reader, id));
  }

  /** Stores the bytes and answers the item's new revision. */
  async putItem(
    reader: string,
    account: Account,
    id: string,
    bytes: Buffer,
    at: string,
  ): Promise<number> {
    await writeAtomic(this.itemFile(reader, id), bytes);
    const rev = account.counter + 1;
    await this.save(reader, {
      ...account,
      counter: rev,
      items: { ...account.items, [id]: { rev, size: bytes.length, at } },
    });
    return rev;
  }

  async deleteItem(
    reader: string,
    account: Account,
    id: string,
  ): Promise<void> {
    const { [id]: _gone, ...items } = account.items;
    await this.save(reader, { ...account, items });
    await fs.rm(this.itemFile(reader, id), { force: true });
  }

  // The cache changes only once the file did, so a failed write leaves both
  // at the old state.
  private async save(reader: string, account: Account): Promise<void> {
    await writeAtomic(this.accountFile(reader), JSON.stringify(account));
    this.accounts.set(reader, account);
  }

  private dir(reader: string): string {
    return path.join(this.dataDir, 'readers', reader);
  }

  private accountFile(reader: string): string {
    return path.join(this.dir(reader), 'reader.json');
  }

  private itemsDir(reader: string): string {
    return path.join(this.dir(reader), 'items');
  }

  private itemFile(reader: string, id: string): string {
    return path.join(this.itemsDir(reader), id);
  }
}
