import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../fsRetry';
import { BrainStateSchema, type BrainState } from '../../shared/brain';

const LOCK_STALE_MS = 3600 * 1000;

const stateFile = (dir: string) => path.join(dir, 'brain', 'state.json');
const lockFile = (dir: string) => path.join(dir, 'brain', 'lock');

/** brain/state.json, validated; `error` says why it could not be read (missing, not JSON, wrong shape). */
export async function readState(
  brainDir: string,
): Promise<{ state: BrainState | null; error: string | null }> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(stateFile(brainDir), 'utf8'),
    );
    const parsed = BrainStateSchema.safeParse(raw);
    if (!parsed.success)
      return {
        state: null,
        error: `brain/state.json is invalid: ${parsed.error.message}`,
      };
    return { state: parsed.data, error: null };
  } catch (e) {
    return { state: null, error: `brain/state.json: ${(e as Error).message}` };
  }
}

/** The session ids of the brain's captured sources, read at once; none when brain/state.json cannot be read. */
export function capturedSessionIds(brainDir: string): string[] {
  try {
    const parsed = BrainStateSchema.safeParse(
      JSON.parse(readFileSync(stateFile(brainDir), 'utf8')),
    );
    if (!parsed.success) return [];
    return Object.values(parsed.data.captured).flatMap((c) =>
      c.sessionId ? [c.sessionId] : [],
    );
  } catch {
    return [];
  }
}

/**
 * Changes brain/state.json atomically (tmp + rename). Fields the schema does not know, written by the skills, are
 * kept. A missing file starts from the defaults; an unreadable one throws.
 */
export async function writeState(
  brainDir: string,
  mutate: (s: BrainState) => BrainState,
): Promise<BrainState> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(stateFile(brainDir), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const next = BrainStateSchema.parse(mutate(BrainStateSchema.parse(raw)));
  const file = stateFile(brainDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(
    file,
    `${JSON.stringify({ ...raw, ...next }, null, 2)}\n`,
    `.${process.pid}.tmp`,
  );
  return next;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes brain/lock; false when a live lock (a running process, younger than an hour) exists. A stale lock is replaced. */
export async function acquireLock(
  brainDir: string,
  pid: number = process.pid,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const file = lockFile(brainDir);
  await mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid, at: now().toISOString() });
  try {
    await writeFile(file, body, { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  try {
    const held = JSON.parse(await readFile(file, 'utf8')) as {
      pid?: unknown;
      at?: unknown;
    };
    const at = typeof held.at === 'string' ? Date.parse(held.at) : NaN;
    const fresh = Number.isFinite(at) && now().getTime() - at <= LOCK_STALE_MS;
    if (fresh && typeof held.pid === 'number' && alive(held.pid)) return false;
  } catch {
    /* unreadable lock: stale */
  }
  await writeFile(file, body);
  return true;
}

export async function releaseLock(brainDir: string): Promise<void> {
  await rm(lockFile(brainDir), { force: true });
}
