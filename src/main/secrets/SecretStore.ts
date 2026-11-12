import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ENVIRONMENTS,
  SECRET_NAME,
  UNREADABLE_MASK,
  maskValue,
  type Environment,
  type GivenTo,
  type SecretInput,
  type SecretScope,
  type SecretView,
} from '../../shared/secrets';
import type { TokenCrypto } from '../services/ConnectionStore';
import { JsonFileStore } from '../usage/JsonFileStore';

const EnvironmentSchema = z.enum(ENVIRONMENTS);
const ScopeSchema = z.union([
  z.literal('all'),
  z.object({ repoId: z.string() }),
]);
const StoredValueSchema = z.object({
  ciphertext: z.string(),
  source: z.string().nullable(),
  changedAt: z.string(),
});
const SecretsFileSchema = z.object({
  version: z.literal(1),
  secrets: z.array(
    z.object({
      id: z.string(),
      scope: ScopeSchema,
      name: z.string(),
      givenTo: z.array(z.enum(['setup', 'run', 'tests', 'shell'])),
      values: z.partialRecord(EnvironmentSchema, StoredValueSchema),
    }),
  ),
  repoDefaults: z.record(
    z.string(),
    z.object({ environment: EnvironmentSchema }),
  ),
});
type SecretsFile = z.infer<typeof SecretsFileSchema>;
type Stored = SecretsFile['secrets'][number];

const empty = (): SecretsFile => ({
  version: 1,
  secrets: [],
  repoDefaults: {},
});

const InputSchema = z.object({
  id: z.string().optional(),
  scope: ScopeSchema,
  name: z.string(),
  givenTo: z.array(z.enum(['setup', 'run', 'tests', 'shell'])),
  values: z.partialRecord(
    EnvironmentSchema,
    z
      .object({
        value: z.string(),
        source: z.string().nullable().optional(),
      })
      .nullable(),
  ),
});

const DUPLICATE = 'A secret with this name already exists in this scope';

const sameScope = (a: SecretScope, b: SecretScope) =>
  a === 'all' || b === 'all' ? a === b : a.repoId === b.repoId;

/** Secrets encrypted at rest (safeStorage via TokenCrypto). Decrypted values leave this class only through main-side calls. */
export class SecretStore {
  private readonly store: JsonFileStore<SecretsFile>;
  /**
   * Each stored ciphertext's plaintext (null: unreadable), decrypted on load and save: safeStorage is async, and
   * the readers (the leak watch's output filter among them) are not. Main memory only.
   */
  private readonly plain = new Map<string, string | null>();
  /** Ciphertexts of saves still running: kept while another save or a delete drops the unused ones. */
  private readonly pending = new Set<string>();

  constructor(
    filePath: string,
    private readonly crypto: TokenCrypto,
    /** One line per reveal: time, name, environment. Never the value. */
    private readonly revealLog: string = path.join(
      path.dirname(filePath),
      'secrets-reveals.log',
    ),
  ) {
    this.store = new JsonFileStore(filePath, SecretsFileSchema, empty);
  }

  private get current(): SecretsFile {
    return this.store.value;
  }

  async load(): Promise<{ recovered: boolean; backup?: string }> {
    const result = await this.store.load();
    this.plain.clear();
    await Promise.all(
      [...this.ciphertexts()].map(async (c) =>
        this.plain.set(
          c,
          await this.crypto.decrypt(Buffer.from(c, 'base64')).catch(() => null),
        ),
      ),
    );
    return result;
  }

  /** Masked views; with a repo id, that repo's secrets and the All ones, with 'all' only the All ones. */
  list(scope?: SecretScope): SecretView[] {
    return this.current.secrets
      .filter(
        (s) =>
          scope === undefined ||
          sameScope(s.scope, scope) ||
          (scope !== 'all' && s.scope === 'all'),
      )
      .map((s) => this.view(s));
  }

  async save(raw: SecretInput): Promise<SecretView> {
    const parsed = InputSchema.safeParse(raw);
    if (!parsed.success) throw new Error('The secret is not valid');
    const input: SecretInput = parsed.data;
    const name = input.name.trim();
    if (!SECRET_NAME.test(name))
      throw new Error(
        'A secret name can use letters, digits and underscores, and cannot start with a digit',
      );
    const adds = Object.entries(input.values).some(([, v]) => v);
    if (adds && !(await this.crypto.available()))
      throw new Error(
        'Encryption is not available on this machine; the secret was not saved',
      );
    const clashes = (f: SecretsFile) =>
      f.secrets.some(
        (s) =>
          s.id !== input.id &&
          s.name.toLowerCase() === name.toLowerCase() &&
          sameScope(s.scope, input.scope),
      );
    if (clashes(this.current)) throw new Error(DUPLICATE);
    const now = new Date().toISOString();
    // Encrypted before the update: its callback is synchronous.
    const sealed = new Map<Environment, string>();
    for (const env of ENVIRONMENTS) {
      const v = input.values[env];
      if (!v) continue;
      const ciphertext = (await this.crypto.encrypt(v.value)).toString(
        'base64',
      );
      sealed.set(env, ciphertext);
      this.plain.set(ciphertext, v.value);
      this.pending.add(ciphertext);
    }
    let saved!: Stored;
    const written = this.store.update((f) => {
      if (clashes(f)) throw new Error(DUPLICATE);
      const existing = input.id
        ? f.secrets.find((s) => s.id === input.id)
        : undefined;
      if (input.id && !existing) throw new Error('Unknown secret');
      const record: Stored = existing ?? {
        id: randomUUID(),
        scope: input.scope,
        name,
        givenTo: [],
        values: {},
      };
      record.scope = input.scope;
      record.name = name;
      record.givenTo = [...new Set(input.givenTo)];
      for (const env of ENVIRONMENTS) {
        const v = input.values[env];
        if (v === undefined) continue;
        if (v === null) delete record.values[env];
        else
          record.values[env] = {
            ciphertext: sealed.get(env)!,
            source: v.source ?? null,
            changedAt: now,
          };
      }
      if (!existing) f.secrets.push(record);
      saved = record;
    });
    await written.finally(() => {
      for (const c of sealed.values()) this.pending.delete(c);
      this.forgetUnused();
    });
    return this.view(saved);
  }

  async delete(id: string): Promise<void> {
    await this.store.update((f) => {
      f.secrets = f.secrets.filter((s) => s.id !== id);
    });
    this.forgetUnused();
  }

  /** The plain value, for an explicit reveal; leaves a record (without the value) in the reveal log. */
  reveal(id: string, env: Environment): string {
    const s = this.find(id);
    const value = this.decrypt(s, env);
    if (value === null)
      throw new Error('That secret has no value for this environment');
    mkdirSync(path.dirname(this.revealLog), { recursive: true });
    appendFileSync(
      this.revealLog,
      `${new Date().toISOString()} ${s.name} ${env}\n`,
      'utf8',
    );
    return value;
  }

  /** What a repo's tabs get for an environment; a repo's own secret beats an All one of the same name. */
  valuesFor(
    repoId: string,
    env: Environment,
  ): Record<string, { value: string; givenTo: GivenTo[] }> {
    const out: Record<string, { value: string; givenTo: GivenTo[] }> = {};
    const pick = (secrets: Stored[]) => {
      for (const s of secrets) {
        const value = this.decrypt(s, env);
        if (value !== null) out[s.name] = { value, givenTo: [...s.givenTo] };
      }
    };
    pick(this.current.secrets.filter((s) => s.scope === 'all'));
    pick(
      this.current.secrets.filter(
        (s) => s.scope !== 'all' && s.scope.repoId === repoId,
      ),
    );
    return out;
  }

  /** A repo's own secrets with their values decrypted (null: unreadable), for the import to compare with. Main only. */
  plainValues(repoId: string): {
    name: string;
    values: Partial<
      Record<Environment, { value: string | null; source: string | null }>
    >;
  }[] {
    return this.current.secrets
      .filter((s) => s.scope !== 'all' && s.scope.repoId === repoId)
      .map((s) => ({
        name: s.name,
        values: Object.fromEntries(
          ENVIRONMENTS.filter((env) => s.values[env]).map((env) => [
            env,
            { value: this.decrypt(s, env), source: s.values[env]!.source },
          ]),
        ),
      }));
  }

  /** Every stored value that applies to these repos, in every environment (for leak watch). */
  allValues(
    repoIds: string[],
  ): { name: string; value: string; env: Environment }[] {
    const out: { name: string; value: string; env: Environment }[] = [];
    for (const s of this.current.secrets) {
      if (s.scope !== 'all' && !repoIds.includes(s.scope.repoId)) continue;
      for (const env of ENVIRONMENTS) {
        const value = this.decrypt(s, env);
        if (value !== null) out.push({ name: s.name, value, env });
      }
    }
    return out;
  }

  repoDefault(repoId: string): Environment {
    return this.current.repoDefaults[repoId]?.environment ?? 'development';
  }

  async setRepoDefault(repoId: string, env: Environment): Promise<void> {
    if (env !== 'development' && env !== 'test')
      throw new Error('A repo can default to Development or Test only');
    await this.store.update((f) => {
      f.repoDefaults[repoId] = { environment: env };
    });
  }

  private find(id: string): Stored {
    const s = this.current.secrets.find((x) => x.id === id);
    if (!s) throw new Error('Unknown secret');
    return s;
  }

  private decrypt(s: Stored, env: Environment): string | null {
    const v = s.values[env];
    return v ? (this.plain.get(v.ciphertext) ?? null) : null;
  }

  /** Drops the plaintext of values no longer stored (replaced, removed, or a save that failed). */
  private forgetUnused(): void {
    const kept = this.ciphertexts();
    for (const c of this.plain.keys())
      if (!kept.has(c) && !this.pending.has(c)) this.plain.delete(c);
  }

  private ciphertexts(): Set<string> {
    return new Set(
      this.current.secrets.flatMap((s) =>
        Object.values(s.values).map((v) => v.ciphertext),
      ),
    );
  }

  private view(s: Stored): SecretView {
    const values: SecretView['values'] = {};
    for (const env of ENVIRONMENTS) {
      const v = s.values[env];
      if (!v) continue;
      const plain = this.decrypt(s, env);
      values[env] = {
        mask: plain === null ? UNREADABLE_MASK : maskValue(plain),
        source: v.source,
        changedAt: v.changedAt,
      };
    }
    return {
      id: s.id,
      scope: s.scope,
      name: s.name,
      givenTo: [...s.givenTo],
      values,
    };
  }
}

/** The start-up notice for a secrets file that could not be read (the store moved it aside); null when it was read. */
export function secretsLoadNotice(loaded: {
  recovered: boolean;
  backup?: string;
}): string | null {
  if (!loaded.recovered) return null;
  return `Shellie couldn't read its secrets file; a backup was kept at ${loaded.backup ?? 'its folder'}. Secrets start empty.`;
}
