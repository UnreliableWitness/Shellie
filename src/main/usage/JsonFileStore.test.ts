import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { JsonFileStore } from './JsonFileStore';

const Schema = z.object({ n: z.number() });
const make = () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'jfs-')), 'f.json');
  return { file, store: new JsonFileStore(file, Schema, () => ({ n: 0 }), 0) };
};
const onDisk = (file: string) => JSON.parse(readFileSync(file, 'utf8')).n;

afterEach(() => vi.useRealTimers());

describe('JsonFileStore delayed writes', () => {
  it('keeps the change in memory and writes it within the given time', async () => {
    vi.useFakeTimers();
    const { file, store } = make();
    await store.update((v) => ({ n: v.n + 1 }), { writeWithinMs: 1000 });
    await store.update((v) => ({ n: v.n + 1 }), { writeWithinMs: 1000 });
    expect(store.value.n).toBe(2);
    expect(existsSync(file)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await store.settled();
    expect(onDisk(file)).toBe(2);
  });

  it('writes on flush, and once only', async () => {
    const { file, store } = make();
    await store.update(() => ({ n: 5 }), { writeWithinMs: 60_000 });
    await store.flush();
    expect(onDisk(file)).toBe(5);
    await store.flush();
    expect(onDisk(file)).toBe(5);
  });

  it('a plain update writes the delayed change with its own', async () => {
    const { file, store } = make();
    await store.update(() => ({ n: 5 }), { writeWithinMs: 60_000 });
    await store.update((v) => ({ n: v.n * 2 }));
    expect(onDisk(file)).toBe(10);
  });
});
