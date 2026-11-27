/**
 * What was read from a file, kept until the file changes: opening a brain reads every page and every source more
 * than once (the index, Health, the page list, the sources list), and on Windows opening a file is the slow part.
 * A file whose size and modified time are as they were is not opened again.
 */
import fs from 'node:fs/promises';

type Kept<T> = { mtimeMs: number; size: number; value: T };

/** How many files are looked at at once. */
const AT_ONCE = 24;

export type FileCache<T> = {
  /** What `parse` made of the file's text, read again only when the file changed. Rejects as `fs.stat` or `fs.readFile` do. */
  read(file: string, parse: (text: string) => T): Promise<T>;
};

export function fileCache<T>(): FileCache<T> {
  const kept = new Map<string, Kept<T>>();
  return {
    async read(file, parse) {
      const st = await fs.stat(file);
      const had = kept.get(file);
      if (had && had.mtimeMs === st.mtimeMs && had.size === st.size)
        return had.value;
      const value = parse(await fs.readFile(file, 'utf8'));
      kept.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
      return value;
    },
  };
}

/** `fn` over every item, a few at a time, results in the items' order. */
export async function mapAtOnce<A, B>(
  items: A[],
  fn: (item: A) => Promise<B>,
): Promise<B[]> {
  const out = new Array<B>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, items.length) }, worker),
  );
  return out;
}
