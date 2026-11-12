import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeCrypto } from '../test-helpers/fakeCrypto';
import { CostServerStore } from './CostServerStore';

async function make(crypto = fakeCrypto()) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-cost-server-'));
  const file = path.join(dir, 'cost-server.json');
  const store = new CostServerStore(file, crypto);
  await store.load();
  return { file, store };
}

const conn = {
  url: 'https://cost.example',
  email: 'a@b.c',
  key: 'sk-company-key-1234',
};

describe('CostServerStore', () => {
  it('stores the key encrypted', async () => {
    const { file, store } = await make();
    expect(store.get()).toBeNull();
    await store.set(conn);
    expect(readFileSync(file, 'utf8')).not.toContain(conn.key);
    expect(store.get()).toEqual(conn);
    const again = new CostServerStore(file, fakeCrypto());
    await again.load();
    expect(again.get()).toEqual(conn);
    await store.clear();
    expect(store.get()).toBeNull();
  });

  it('refuses to store the key when encryption is unavailable', async () => {
    const { file, store } = await make(fakeCrypto(false));
    await expect(store.set(conn)).rejects.toThrow(/encryption/i);
    expect(store.get()).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('caches the last budgets and drops them on clear', async () => {
    const { store } = await make();
    const b = { claude: { monthlyEur: 100, monthStartDay: 1 }, copilot: null };
    await store.set(conn);
    await store.setBudgets(b);
    expect(store.budgets).toEqual(b);
    await store.clear();
    expect(store.budgets).toBeNull();
  });

  it('tells when the budgets change, not when the same answer comes again', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-cost-server-'));
    const changed = vi.fn();
    const store = new CostServerStore(
      path.join(dir, 'cost-server.json'),
      fakeCrypto(),
      changed,
    );
    await store.load();
    const b = { claude: { monthlyEur: 100, monthStartDay: 1 }, copilot: null };
    await store.setBudgets(b);
    await store.setBudgets({ ...b });
    expect(changed).toHaveBeenCalledTimes(1);
    await store.clear();
    expect(changed).toHaveBeenCalledTimes(2);
    await store.clear();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('keeps the last send and the refused-key marker across a restart, and drops them on clear', async () => {
    const { file, store } = await make();
    await store.set(conn);
    await store.setLastSentAt('2026-10-23T10:00:00.000Z');
    await store.setRefused('ab12');
    const again = new CostServerStore(file, fakeCrypto());
    await again.load();
    expect(again.lastSentAt).toBe('2026-10-23T10:00:00.000Z');
    expect(again.refused).toBe('ab12');
    expect(readFileSync(file, 'utf8')).not.toContain(conn.key);
    await again.clear();
    expect(again.lastSentAt).toBeNull();
    expect(again.refused).toBeNull();
  });

  it('applies the cached budgets only while the connection can be read', async () => {
    const { file, store } = await make();
    const b = { claude: { monthlyEur: 100, monthStartDay: 1 }, copilot: null };
    await store.set(conn);
    await store.setBudgets(b);
    expect(store.budgets).toEqual(b);
    const other = new CostServerStore(file, {
      ...fakeCrypto(),
      decrypt: async () => {
        throw new Error('cannot decrypt');
      },
    });
    await other.load();
    expect(other.get()).toBeNull();
    expect(other.budgets).toBeNull();
  });
});
