import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realWait, withRetry, writeAtomic, type Wait } from './fsRetry';

/**
 * This installation's id: a UUID kept in `<userData>/install-id`, created once. Only a missing or empty file mints
 * one; any other read error (EBUSY or EPERM on Windows) is retried a few times, then thrown, since a new id would
 * lose the keeper. Main reads it once at start and hands the same id to everything that needs it.
 */
export async function getInstallId(
  userData: string,
  wait: Wait = realWait,
): Promise<string> {
  const file = path.join(userData, 'install-id');
  try {
    const text = await withRetry(
      () => readFile(file, 'utf8'),
      (e) => (e as NodeJS.ErrnoException).code !== 'ENOENT',
      wait,
    );
    const id = text.trim();
    if (id) return id;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const id = randomUUID();
  await mkdir(userData, { recursive: true });
  await writeAtomic(file, `${id}\n`, `.${process.pid}.tmp`);
  return id;
}
