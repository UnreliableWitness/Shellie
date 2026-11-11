import { z } from 'zod';
import {
  b64url,
  fromB64url,
  ReaderMarkSchema,
  SECRET_BYTES,
  type ReaderMarkSet,
  type ReaderStatus,
} from '../../shared/reader';
import type { TokenCrypto } from '../services/ConnectionStore';
import { JsonFileStore } from '../usage/JsonFileStore';

const LastPushSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  pieces: z.number(),
  error: z.string().nullable(),
});
const FileSchema = z.object({
  version: z.literal(1),
  connection: z
    .object({ url: z.string(), secretCiphertext: z.string() })
    .nullable(),
  lastPush: LastPushSchema.nullable().default(null),
  /** The server refused the token: nothing is sent until the connection changes. */
  refused: z.boolean().default(false),
  /** Per brain, per item id: a hash of what was last sent. */
  sent: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /** Per brain: what the person marked as read, here or on the phone. */
  marks: z
    .record(z.string(), z.record(z.string(), ReaderMarkSchema))
    .default({}),
});
type ReaderFile = z.infer<typeof FileSchema>;

export type ReaderConnection = { url: string; secret: Uint8Array };

const empty = (): ReaderFile => ({
  version: 1,
  connection: null,
  lastPush: null,
  refused: false,
  sent: {},
  marks: {},
});

/**
 * The phone reading site's connection (its address, and the secret everything is made from, encrypted with
 * safeStorage via TokenCrypto), what was last sent, and the read marks of every brain.
 */
export class ReaderStore {
  private readonly store: JsonFileStore<ReaderFile>;

  constructor(
    file: string,
    private readonly crypto: TokenCrypto,
  ) {
    this.store = new JsonFileStore(file, FileSchema, empty);
  }

  load(): Promise<{ recovered: boolean; backup?: string }> {
    return this.store.load();
  }

  /** The connection with its secret decrypted; null when none is saved or the secret cannot be read. */
  get(): ReaderConnection | null {
    const c = this.store.value.connection;
    if (!c) return null;
    try {
      const secret = fromB64url(
        this.crypto.decrypt(Buffer.from(c.secretCiphertext, 'base64')),
      );
      return secret?.length === SECRET_BYTES ? { url: c.url, secret } : null;
    } catch {
      return null;
    }
  }

  async set(c: ReaderConnection): Promise<void> {
    if (!this.crypto.available())
      throw new Error(
        'Encryption is not available on this machine; the connection was not saved',
      );
    const secretCiphertext = this.crypto
      .encrypt(b64url(c.secret))
      .toString('base64');
    await this.store.update((f) => {
      f.connection = { url: c.url, secretCiphertext };
      f.lastPush = null;
      f.refused = false;
      f.sent = {};
    });
  }

  /** Forgets the connection and what was sent. The marks stay: they are the person's, with or without a phone. */
  async clear(): Promise<void> {
    await this.store.update((f) => {
      f.connection = null;
      f.lastPush = null;
      f.refused = false;
      f.sent = {};
    });
  }

  status(): ReaderStatus {
    const f = this.store.value;
    const c = this.get();
    return {
      connected: c !== null,
      url: c?.url ?? null,
      lastPush: c ? f.lastPush : null,
      refused: c !== null && f.refused,
    };
  }

  get refused(): boolean {
    return this.store.value.refused;
  }

  async setRefused(refused: boolean): Promise<void> {
    if (this.store.value.refused === refused) return;
    await this.store.update((f) => {
      f.refused = refused;
    });
  }

  async setLastPush(p: ReaderFile['lastPush']): Promise<void> {
    await this.store.update((f) => {
      f.lastPush = p;
    });
  }

  /** The brains something was sent for. */
  sentBrains(): string[] {
    return Object.keys(this.store.value.sent);
  }

  sent(brainId: string): Record<string, string> {
    return this.store.value.sent[brainId] ?? {};
  }

  /** What is on the server for a brain now; null when nothing is. */
  async setSent(
    brainId: string,
    sent: Record<string, string> | null,
  ): Promise<void> {
    if (!sent && !(brainId in this.store.value.sent)) return;
    await this.store.update((f) => {
      if (sent) f.sent[brainId] = sent;
      else delete f.sent[brainId];
    });
  }

  marks(brainId: string): ReaderMarkSet {
    return this.store.value.marks[brainId] ?? {};
  }

  async setMarks(brainId: string, marks: ReaderMarkSet): Promise<void> {
    await this.store.update((f) => {
      f.marks[brainId] = marks;
    });
  }

  /** The brains marks are kept for. */
  knownBrains(): string[] {
    return Object.keys(this.store.value.marks);
  }

  async dropMarks(brainId: string): Promise<void> {
    if (!(brainId in this.store.value.marks)) return;
    await this.store.update((f) => {
      delete f.marks[brainId];
    });
  }
}
