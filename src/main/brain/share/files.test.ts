import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readMembers,
  readOrigin,
  readShared,
  removeMember,
  upsertMember,
  writeOrigin,
  writeShared,
} from './files';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'share-files-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('share files', () => {
  it('reads null when missing', async () => {
    expect(await readOrigin(dir)).toBeNull();
    expect(await readMembers(dir)).toBeNull();
    expect(await readShared(dir)).toBeNull();
  });

  it('round-trips the origin', async () => {
    const o = {
      format: 1 as const,
      organizationUrl: 'https://dev.azure.com/o',
      project: 'p',
      name: 'Acme',
      keeper: { installId: 'a', name: 'Ann' },
      sharedAt: '2026-11-13T10:00:00.000Z',
    };
    await writeOrigin(dir, o);
    expect(await readOrigin(dir)).toEqual(o);
  });

  it('upserts and removes members', async () => {
    const t = '2026-11-13T10:00:00.000Z';
    await upsertMember(dir, { installId: 'a', name: 'Ann', joinedAt: t });
    await upsertMember(dir, { installId: 'b', name: 'Bob', joinedAt: t });
    await upsertMember(dir, { installId: 'a', name: 'Anna', joinedAt: t });
    expect((await readMembers(dir))?.members).toEqual([
      { installId: 'a', name: 'Anna', joinedAt: t },
      { installId: 'b', name: 'Bob', joinedAt: t },
    ]);
    await removeMember(dir, 'a');
    expect((await readMembers(dir))?.members.map((m) => m.installId)).toEqual([
      'b',
    ]);
  });

  it('writeShared stamps only the fields given', async () => {
    const t1 = new Date('2026-11-13T10:00:00.000Z');
    const t2 = new Date('2026-11-13T11:00:00.000Z');
    await writeShared(dir, { lastRefreshAt: t1.toISOString() }, t1);
    await writeShared(dir, { templatesVersion: 10 }, t2);
    const s = await readShared(dir);
    expect(s?.lastRefreshAt).toBe(t1.toISOString());
    expect(s?.templatesVersion).toBe(10);
    expect(s?.updatedAt.lastRefreshAt).toBe(t1.toISOString());
    expect(s?.updatedAt.templatesVersion).toBe(t2.toISOString());
    expect(s?.updatedAt.wiki).toBe(new Date(0).toISOString());
    expect(s?.updatedAt.lastDigestAt).toBe(new Date(0).toISOString());
  });

  it('throws on a corrupt file and never overwrites it', async () => {
    await mkdir(path.join(dir, 'brain'), { recursive: true });
    const corrupt = '<<<<<<< HEAD\n{"format": 1\n';
    for (const name of ['members.json', 'shared.json', 'origin.json']) {
      await writeFile(path.join(dir, 'brain', name), corrupt);
    }
    await expect(readMembers(dir)).rejects.toThrow();
    await expect(readShared(dir)).rejects.toThrow();
    await expect(readOrigin(dir)).rejects.toThrow();
    await expect(
      upsertMember(dir, { installId: 'a', name: 'A', joinedAt: 't' }),
    ).rejects.toThrow();
    await expect(
      writeShared(dir, { templatesVersion: 1 }, new Date()),
    ).rejects.toThrow();
    for (const name of ['members.json', 'shared.json']) {
      expect(await readFile(path.join(dir, 'brain', name), 'utf8')).toBe(
        corrupt,
      );
    }
  });
});
