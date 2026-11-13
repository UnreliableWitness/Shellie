import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeAtomic } from './fsRetry';

/** This installation's id: a UUID kept in `<userData>/install-id`, created once. */
export async function getInstallId(userData: string): Promise<string> {
  const file = path.join(userData, 'install-id');
  try {
    const id = (await readFile(file, 'utf8')).trim();
    if (id) return id;
  } catch {
    // missing: create below
  }
  const id = randomUUID();
  await mkdir(userData, { recursive: true });
  await writeAtomic(file, `${id}\n`, `.${process.pid}.tmp`);
  return id;
}
