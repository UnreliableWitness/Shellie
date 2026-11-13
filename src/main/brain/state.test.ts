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
  withBrainLock,
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

  it("keeps each finding's conflict as lint wrote it, valid or not, when Shellie writes the state", async () => {
    const conflict = {
      id: 'contradiction:wiki/a.md+wiki/b.md:go-live',
      question: 'When?',
      claims: {
        a: { page: 'wiki/a.md', quote: 'x' },
        b: { page: 'wiki/b.md', quote: 'y' },
      },
      extra: [1, 2],
    };
    await writeFile(
      path.join(dir, 'brain', 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        findings: [
          {
            kind: 'contradiction',
            page: 'wiki/a.md',
            detail: 'd',
            at: 'now',
            conflict,
          },
          {
            kind: 'scope-change',
            page: 'wiki/s.md',
            detail: 'e',
            at: 'now',
            conflict: 42,
          },
        ],
      }),
    );
    expect((await readState(dir)).state?.findings).toHaveLength(2);
    await writeState(dir, (s) => ({
      ...s,
      captured: { 'sources/x.md': { at: 'now', sessionId: null } },
    }));
    const raw = JSON.parse(
      await readFile(path.join(dir, 'brain', 'state.json'), 'utf8'),
    );
    expect(raw.findings[0].conflict).toEqual(conflict);
    expect(raw.findings[1].conflict).toBe(42);
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

  it('withBrainLock runs under the lock and releases it, even when the work throws', async () => {
    expect(
      await withBrainLock<boolean | string>(
        dir,
        async () => existsSync(lock()),
        { busy: () => 'busy' },
      ),
    ).toBe(true);
    expect(existsSync(lock())).toBe(false);
    await expect(
      withBrainLock(
        dir,
        async () => {
          throw new Error('boom');
        },
        { busy: () => 'busy' },
      ),
    ).rejects.toThrow('boom');
    expect(existsSync(lock())).toBe(false);
  });

  it('withBrainLock answers busy and leaves a lock it did not take', async () => {
    await acquireLock(dir);
    let ran = false;
    expect(
      await withBrainLock(
        dir,
        async () => {
          ran = true;
          return 'ran';
        },
        { busy: () => 'busy' },
      ),
    ).toBe('busy');
    expect(ran).toBe(false);
    expect(existsSync(lock())).toBe(true);
  });
});
