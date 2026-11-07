import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  capturedSessionIds,
  readState,
  releaseLock,
  writeState,
} from './state';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'brain-state-'));
  await mkdir(path.join(dir, 'brain'));
  await writeFile(path.join(dir, 'brain', 'state.json'), '{"schemaVersion":1}');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('state', () => {
  it('reads defaults and reports a broken file', async () => {
    expect((await readState(dir)).state?.captured).toEqual({});
    await writeFile(path.join(dir, 'brain', 'state.json'), '{nope');
    const r = await readState(dir);
    expect(r.state).toBeNull();
    expect(r.error).toContain('state.json');
  });

  it('keeps fields it does not know when writing', async () => {
    await writeFile(
      path.join(dir, 'brain', 'state.json'),
      '{"schemaVersion":1,"custom":{"a":1}}',
    );
    await writeState(dir, (s) => ({ ...s, lastLintAt: 'now' }));
    const raw = JSON.parse(
      await readFile(path.join(dir, 'brain', 'state.json'), 'utf8'),
    );
    expect(raw.custom).toEqual({ a: 1 });
    expect(raw.lastLintAt).toBe('now');
  });

  it('lists the captured session ids, none for a broken file', async () => {
    await writeState(dir, (s) => ({
      ...s,
      captured: {
        'sources/a.md': { at: 't', sessionId: 'ses_a' },
        'sources/b.md': { at: 't', sessionId: null },
      },
    }));
    expect(capturedSessionIds(dir)).toEqual(['ses_a']);
    await writeFile(path.join(dir, 'brain', 'state.json'), '{nope');
    expect(capturedSessionIds(dir)).toEqual([]);
  });
});

describe('lock', () => {
  const lock = () => path.join(dir, 'brain', 'lock');

  it('refuses a live lock and replaces a stale one', async () => {
    expect(await acquireLock(dir)).toBe(true);
    expect(await acquireLock(dir)).toBe(false);
    await writeFile(
      lock(),
      JSON.stringify({ pid: 999999, at: new Date().toISOString() }),
    );
    expect(await acquireLock(dir)).toBe(true);
    expect(JSON.parse(await readFile(lock(), 'utf8')).pid).toBe(process.pid);
  });

  it('replaces a lock older than an hour', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    expect(await acquireLock(dir, process.pid, () => t0)).toBe(true);
    expect(
      await acquireLock(
        dir,
        process.pid,
        () => new Date(t0.getTime() + 3_500_000),
      ),
    ).toBe(false);
    expect(
      await acquireLock(
        dir,
        process.pid,
        () => new Date(t0.getTime() + 3_601_000),
      ),
    ).toBe(true);
  });

  it('releases', async () => {
    await acquireLock(dir);
    await releaseLock(dir);
    expect(existsSync(lock())).toBe(false);
  });
});
