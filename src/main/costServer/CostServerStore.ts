import { z } from 'zod';
import type { ServerBudgets } from '../../shared/costServer';
import type { TokenCrypto } from '../services/ConnectionStore';
import { JsonFileStore } from '../usage/JsonFileStore';

const BudgetSchema = z
  .object({ monthlyEur: z.number(), monthStartDay: z.number() })
  .nullable();
const BudgetsSchema = z.object({
  claude: BudgetSchema,
  copilot: BudgetSchema,
});
const FileSchema = z.object({
  version: z.literal(1),
  connection: z
    .object({ url: z.string(), email: z.string(), keyCiphertext: z.string() })
    .nullable(),
  budgets: BudgetsSchema.nullable(),
  /** When the server last accepted records; shown in Settings after a relaunch. */
  lastSentAt: z.string().nullable().optional(),
  /** A hash of the address, email and key the server refused (never the key): no new notice, no retry, until it changes. */
  refused: z.string().nullable().optional(),
});
type CostServerFile = z.infer<typeof FileSchema>;

export type CostServerConnection = { url: string; email: string; key: string };

const empty = (): CostServerFile => ({
  version: 1,
  connection: null,
  budgets: null,
});

/** The cost server's address, the developer's email and the company key (encrypted with safeStorage via TokenCrypto). */
export class CostServerStore {
  private readonly store: JsonFileStore<CostServerFile>;
  /** The key, decrypted once on load or set (safeStorage is async, the readers are not); null when it cannot be read. */
  private key: string | null = null;

  constructor(
    file: string,
    private readonly crypto: TokenCrypto,
    /** The cached budgets changed (a new `hello` answer, or a disconnect). */
    private readonly budgetsChanged: () => void = () => {},
  ) {
    this.store = new JsonFileStore(file, FileSchema, empty);
  }

  async load(): Promise<{ recovered: boolean; backup?: string }> {
    const result = await this.store.load();
    const c = this.store.value.connection;
    this.key = c
      ? await this.crypto
          .decrypt(Buffer.from(c.keyCiphertext, 'base64'))
          .catch(() => null)
      : null;
    return result;
  }

  /** The connection with its key decrypted; null when none is saved or the key cannot be read. */
  get(): CostServerConnection | null {
    const c = this.store.value.connection;
    if (!c || this.key === null) return null;
    return { url: c.url, email: c.email, key: this.key };
  }

  async set(c: CostServerConnection): Promise<void> {
    if (!(await this.crypto.available()))
      throw new Error(
        'Encryption is not available on this machine; the key was not saved',
      );
    const keyCiphertext = (await this.crypto.encrypt(c.key)).toString('base64');
    await this.store.update((f) => {
      f.connection = { url: c.url, email: c.email, keyCiphertext };
    });
    this.key = c.key;
  }

  async clear(): Promise<void> {
    const had = this.store.value.budgets !== null;
    await this.store.update((f) => {
      f.connection = null;
      f.budgets = null;
      f.lastSentAt = null;
      f.refused = null;
    });
    this.key = null;
    if (had) this.budgetsChanged();
  }

  /** The last `hello` answer; it applies only while the connection can be read (its key decrypts). */
  get budgets(): ServerBudgets | null {
    const b = this.store.value.budgets;
    return b && this.get() ? b : null;
  }

  get lastSentAt(): string | null {
    return this.store.value.lastSentAt ?? null;
  }

  async setLastSentAt(at: string | null): Promise<void> {
    await this.store.update((f) => {
      f.lastSentAt = at;
    });
  }

  get refused(): string | null {
    return this.store.value.refused ?? null;
  }

  async setRefused(sig: string | null): Promise<void> {
    if ((this.store.value.refused ?? null) === sig) return;
    await this.store.update((f) => {
      f.refused = sig;
    });
  }

  async setBudgets(b: ServerBudgets | null): Promise<void> {
    const same = JSON.stringify(this.store.value.budgets) === JSON.stringify(b);
    await this.store.update((f) => {
      f.budgets = b;
    });
    if (!same) this.budgetsChanged();
  }
}
