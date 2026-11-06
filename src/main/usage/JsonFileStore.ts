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

  update(mutate: (v: T) => T | void): Promise<T> {
    const run = async () => {
      const draft = structuredClone(this.current);
      const next = this.schema.parse(mutate(draft) ?? draft);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await writeAtomic(this.file, JSON.stringify(next, null, this.indent));
      this.current = next;
      return next;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
