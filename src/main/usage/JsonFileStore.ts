import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { renameWithRetry, writeAtomic } from '../fsRetry';
import { errorMessage } from '../../shared/errors';

/** One JSON document on disk, zod-validated, written atomically and serially; a corrupt file is backed up. */
export class JsonFileStore<T> {
  private current: T;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly schema: z.ZodType<T>,
    private readonly empty: () => T,
    /** JSON.stringify indent; 0 writes compact JSON. */
    private readonly indent = 2,
  ) {
    this.current = empty();
  }

  get value(): T {
    return this.current;
  }

  async load(): Promise<{ recovered: boolean; backup?: string }> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.current = this.empty();
        return { recovered: false };
      }
      throw e;
    }
    try {
      this.current = this.schema.parse(JSON.parse(raw));
      return { recovered: false };
    } catch {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        await renameWithRetry(this.file, backup);
      } catch {
        // Rename can fail on Windows when the file is locked; keep a copy instead.
        try {
          await fs.copyFile(this.file, backup);
        } catch (e) {
          throw new Error(
            `${path.basename(this.file)} is corrupt and could not be backed up to ${backup}: ${errorMessage(e)}`,
          );
        }
      }
      this.current = this.empty();
      return { recovered: true, backup };
    }
  }

  /** Resolves once every queued update has finished (failed ones included). */
  async settled(): Promise<void> {
    await this.queue;
  }

  /**
   * Applies `mutate` to a copy and writes it. With `writeWithinMs` the change is kept in memory at once
   * and written within that time (or by the next update or `flush`), unvalidated: for a large file that
   * changes often and whose last few changes may be lost on a crash.
   */
  update(
    mutate: (v: T) => T | void,
    opts: { writeWithinMs?: number } = {},
  ): Promise<T> {
    const run = async () => {
      const draft = structuredClone(this.current);
      const out = mutate(draft) ?? draft;
      if (opts.writeWithinMs !== undefined) {
        this.current = out;
        this.dirty = true;
        this.later ??= setTimeout(() => {
          this.later = null;
          this.flush().catch((e) =>
            console.warn(
              `[store] could not write ${path.basename(this.file)}`,
              e,
            ),
          );
        }, opts.writeWithinMs);
        this.later.unref?.();
        return out;
      }
      const next = this.schema.parse(out);
      await this.write(next);
      this.current = next;
      this.dirty = false;
      return next;
    };
    return this.enqueue(run);
  }

  /** Writes a change that `update` kept in memory; nothing when there is none. */
  flush(): Promise<void> {
    if (this.later) clearTimeout(this.later);
    this.later = null;
    return this.enqueue(async () => {
      if (!this.dirty) return;
      await this.write(this.current);
      this.dirty = false;
    });
  }

  private dirty = false;
  private later: ReturnType<typeof setTimeout> | null = null;

  private enqueue<R>(run: () => Promise<R>): Promise<R> {
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async write(value: T): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeAtomic(this.file, JSON.stringify(value, null, this.indent));
  }
}
