import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getInstallId } from './installId';

// Windows' EBUSY on demand: a chmod 000 file is still readable there.
const busy = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = ((...args: Parameters<typeof fs.readFile>) =>
    busy.on
      ? Promise.reject(
          Object.assign(new Error('EBUSY: resource busy or locked'), {
            code: 'EBUSY',
          }),
        )
      : fs.readFile(...args)) as typeof fs.readFile;
  return { ...fs, readFile, default: { ...fs, readFile } };
});

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'install-id-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe('getInstallId', () => {
  it('is stable in a folder and differs between folders', async () => {
    const a = await tmp();
    const b = await tmp();
    const id = await getInstallId(a);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getInstallId(a)).toBe(id);
    expect(await getInstallId(b)).not.toBe(id);
  });

  it('mints an id for a missing or empty file and keeps it', async () => {
    const a = await tmp();
    await writeFile(path.join(a, 'install-id'), '\n');
    const id = await getInstallId(a);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await readFile(path.join(a, 'install-id'), 'utf8')).trim()).toBe(
      id,
    );
  });

  it('never mints a new id when the file cannot be read', async () => {
    const a = await tmp();
    // A file Windows holds busy (EBUSY): the id in it must survive.
    const file = path.join(a, 'install-id');
    await writeFile(file, 'kept-id\n');
    busy.on = true;
    try {
      await expect(getInstallId(a, async () => {})).rejects.toThrow('EBUSY');
    } finally {
      busy.on = false;
    }
    expect(await readFile(file, 'utf8')).toBe('kept-id\n');
  });
});
