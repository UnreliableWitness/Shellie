import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { maskValue } from '../../shared/secrets';
import { fakeCrypto } from '../test-helpers/fakeCrypto';
import { SecretStore, secretsLoadNotice } from './SecretStore';

async function make() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-secrets-'));
  const file = path.join(dir, 'secrets.json');
  const store = new SecretStore(file, fakeCrypto());
  await store.load();
  return { dir, file, store };
}

describe('maskValue', () => {
  it('keeps a known prefix and the last four', () => {
    expect(maskValue('sk_live_abcdefghijkl0b3d')).toBe('sk_live_••••0b3d');
    expect(maskValue('plainvalue-with-tail1234')).toBe('••••1234');
    expect(maskValue('short')).toBe('••••');
  });
});

describe('SecretStore', () => {
  it('round-trips awkward values through a reload, ciphertext on disk', async () => {
    const { file, store } = await make();
    const value = 'a=b;"c"#d\n$e';
    await store.save({
      scope: { repoId: 'r1' },
      name: 'DB',
      givenTo: ['run'],
      values: { development: { value } },
    });
    expect(readFileSync(file, 'utf8')).not.toContain('a=b');
    const again = new SecretStore(file, fakeCrypto());
    await again.load();
    expect(again.valuesFor('r1', 'development').DB.value).toBe(value);
  });

  it('lists masks only', async () => {
    const { store } = await make();
    await store.save({
      scope: 'all',
      name: 'STRIPE',
      givenTo: [],
      values: { production: { value: 'sk_live_abcdefghijkl0b3d' } },
    });
    const json = JSON.stringify(store.list());
    expect(json).toContain('sk_live_••••0b3d');
    expect(json).not.toContain('abcdefghijkl');
  });

  it('lets a repo secret beat an all secret of the same name', async () => {
    const { store } = await make();
    await store.save({
      scope: 'all',
      name: 'K',
      givenTo: ['run'],
      values: { development: { value: 'global' } },
    });
    await store.save({
      scope: { repoId: 'r1' },
      name: 'K',
      givenTo: ['shell'],
      values: { development: { value: 'local' } },
    });
    expect(store.valuesFor('r1', 'development').K).toEqual({
      value: 'local',
      givenTo: ['shell'],
    });
    expect(store.valuesFor('r2', 'development').K.value).toBe('global');
  });

  it('rejects invalid names and duplicates', async () => {
    const { store } = await make();
    await expect(
      store.save({ scope: 'all', name: '1bad', givenTo: [], values: {} }),
    ).rejects.toThrow(/name/);
    await store.save({ scope: 'all', name: 'OK', givenTo: [], values: {} });
    await expect(
      store.save({ scope: 'all', name: 'OK', givenTo: [], values: {} }),
    ).rejects.toThrow(/already/);
  });

  it('updates, keeps absent environments and deletes null ones', async () => {
    const { store } = await make();
    const v = await store.save({
      scope: 'all',
      name: 'K',
      givenTo: [],
      values: { development: { value: 'd' }, test: { value: 't' } },
    });
    const next = await store.save({
      id: v.id,
      scope: 'all',
      name: 'K',
      givenTo: [],
      values: { test: null },
    });
    expect(Object.keys(next.values)).toEqual(['development']);
    await store.delete(v.id);
    expect(store.list()).toEqual([]);
  });

  it('loads empty from a missing or old file', async () => {
    const { file, store } = await make();
    expect(store.list()).toEqual([]);
    writeFileSync(file, JSON.stringify({ version: 0 }));
    const again = new SecretStore(file, fakeCrypto());
    expect((await again.load()).recovered).toBe(true);
    expect(again.list()).toEqual([]);
  });

  it('reveals the value and logs time, name and environment without it', async () => {
    const { dir, store } = await make();
    const v = await store.save({
      scope: 'all',
      name: 'TOKEN',
      givenTo: [],
      values: { uat: { value: 'super-secret-value' } },
    });
    expect(store.reveal(v.id, 'uat')).toBe('super-secret-value');
    const log = readFileSync(path.join(dir, 'secrets-reveals.log'), 'utf8');
    expect(log).toMatch(/^\d{4}-\d\d-\d\dT.* TOKEN uat\n$/);
    expect(log).not.toContain('super-secret');
  });

  it('serializes the duplicate check, case-insensitively', async () => {
    const { file, store } = await make();
    const mk = (name: string) =>
      store.save({ scope: 'all', name, givenTo: [], values: {} });
    const results = await Promise.allSettled([mk('Dup'), mk('DUP')]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(JSON.parse(readFileSync(file, 'utf8')).secrets).toHaveLength(1);
  });

  it('rejects malformed input and never puts names or values in errors', async () => {
    const { store } = await make();
    const bad = [
      {
        scope: 'all',
        name: 'NAMEX',
        givenTo: [],
        values: { test: { value: 42 } },
      },
      { scope: 'all', name: 'NAMEX', givenTo: ['everywhere'], values: {} },
    ] as unknown as Parameters<typeof store.save>[0][];
    const errors: string[] = [];
    const grab = async (p: () => unknown) => {
      try {
        await p();
      } catch (e) {
        errors.push((e as Error).message);
      }
    };
    const input = (name: string) => ({
      scope: 'all' as const,
      name,
      givenTo: [],
      values: { test: { value: 'VALUEX' } },
    });
    for (const b of bad) await grab(() => store.save(b));
    await grab(() => store.save(input('NAMEX bad')));
    const ok = await store.save(input('NAMEX'));
    await grab(() => store.save(input('namex')));
    await grab(() =>
      store.save({ ...input('OTHER'), id: 'ghost-NAMEX', values: {} }),
    );
    await grab(() => store.reveal(ok.id, 'uat'));
    await grab(() => store.reveal('ghost-NAMEX', 'test'));
    await grab(() => store.setRepoDefault('r', 'production'));
    await store.delete('ghost');
    expect(errors).toHaveLength(8);
    for (const m of errors) expect(m).not.toMatch(/namex|valuex/i);
  });

  it('marks a value that cannot be decrypted', async () => {
    const { file, store } = await make();
    await store.save({
      scope: 'all',
      name: 'K',
      givenTo: [],
      values: { test: { value: 'abc' } },
    });
    const other = new SecretStore(file, {
      available: async () => true,
      encrypt: async (s) => Buffer.from(s),
      decrypt: async () => {
        throw new Error('no key');
      },
    });
    await other.load();
    const [id] = other.list().map((v) => v.id);
    expect(other.list()[0].values.test?.mask).toBe('⚠ unreadable');
    expect(other.valuesFor('r1', 'test')).toEqual({});
    expect(other.allValues(['r1'])).toEqual([]);
    expect(() => other.reveal(id, 'test')).toThrow(/no value/);
  });

  it('reads a value the sync safeStorage API wrote, through the async one', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-secrets-'));
    const file = path.join(dir, 'secrets.json');
    // What 1.95 wrote: the ciphertext of encryptString, base64.
    const old = Buffer.from(
      'sk_live_abcdefghijkl0b3d'.split('').reverse().join(''),
    );
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        secrets: [
          {
            id: 's1',
            scope: 'all',
            name: 'STRIPE',
            givenTo: ['run'],
            values: {
              development: {
                ciphertext: old.toString('base64'),
                source: null,
                changedAt: '2026-11-01T00:00:00.000Z',
              },
            },
          },
        ],
        repoDefaults: {},
      }),
    );
    const store = new SecretStore(file, fakeCrypto());
    await store.load();
    expect(store.list()[0].values.development?.mask).toBe('sk_live_••••0b3d');
    expect(store.reveal('s1', 'development')).toBe('sk_live_abcdefghijkl0b3d');
  });

  it('keeps the values of saves that run at the same time, and drops a replaced one', async () => {
    const { store } = await make();
    const [a, b] = await Promise.all([
      store.save({
        scope: 'all',
        name: 'A',
        givenTo: [],
        values: { development: { value: 'first-value' } },
      }),
      store.save({
        scope: 'all',
        name: 'B',
        givenTo: [],
        values: { development: { value: 'second-value' } },
      }),
    ]);
    expect(store.reveal(a.id, 'development')).toBe('first-value');
    expect(store.reveal(b.id, 'development')).toBe('second-value');
    await store.save({
      id: a.id,
      scope: 'all',
      name: 'A',
      givenTo: [],
      values: { development: { value: 'replaced' } },
    });
    expect(
      store
        .allValues([])
        .map((v) => v.value)
        .sort(),
    ).toEqual(['replaced', 'second-value']);
  });

  it('collects every value for a repo, and limits defaults to development and test', async () => {
    const { store } = await make();
    await store.save({
      scope: { repoId: 'r1' },
      name: 'A',
      givenTo: [],
      values: { development: { value: 'x' }, production: { value: 'y' } },
    });
    await store.save({
      scope: { repoId: 'r2' },
      name: 'B',
      givenTo: [],
      values: { development: { value: 'z' } },
    });
    expect(
      store
        .allValues(['r1'])
        .map((v) => v.env)
        .sort(),
    ).toEqual(['development', 'production']);
    expect(store.repoDefault('r1')).toBe('development');
    await store.setRepoDefault('r1', 'test');
    expect(store.repoDefault('r1')).toBe('test');
    await expect(store.setRepoDefault('r1', 'production')).rejects.toThrow();
  });
});

describe('an unreadable secrets file', () => {
  it('is moved to a backup, and the notice says where', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-secrets-bad-'));
    const file = path.join(dir, 'secrets.json');
    writeFileSync(file, '{ not json');
    const s = new SecretStore(file, fakeCrypto());
    const loaded = await s.load();
    expect(loaded.recovered).toBe(true);
    expect(secretsLoadNotice(loaded)).toBe(
      `Shellie couldn't read its secrets file; a backup was kept at ${loaded.backup}. Secrets start empty.`,
    );
    expect(secretsLoadNotice({ recovered: false })).toBeNull();
  });
});
