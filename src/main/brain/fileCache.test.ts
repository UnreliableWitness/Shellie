import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileCache, mapAtOnce } from './fileCache';
import { readPages } from './pages';

describe('fileCache', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-filecache-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('parses a file once until it changes', async () => {
    const file = path.join(dir, 'a.md');
    await fs.writeFile(file, 'one');
    const parse = vi.fn((text: string) => text.toUpperCase());
    const cache = fileCache<string>();
    expect(await cache.read(file, parse)).toBe('ONE');
    expect(await cache.read(file, parse)).toBe('ONE');
    expect(parse).toHaveBeenCalledTimes(1);
    await fs.writeFile(file, 'two!');
    expect(await cache.read(file, parse)).toBe('TWO!');
    // The same size, a later time: still read again.
    await fs.writeFile(file, 'six!');
    await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
    expect(await cache.read(file, parse)).toBe('SIX!');
    expect(parse).toHaveBeenCalledTimes(3);
    await fs.rm(file);
    await expect(cache.read(file, parse)).rejects.toThrow();
  });

  it('keeps the order of what it maps', async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    expect(
      await mapAtOnce(items, async (i) => {
        await new Promise((r) => setTimeout(r, (i * 7) % 5));
        return i * 2;
      }),
    ).toEqual(items.map((i) => i * 2));
  });

  it('readPages sees a page that was edited, added or removed, and hands out copies', async () => {
    const page = (name: string, title: string) =>
      fs.writeFile(
        path.join(dir, 'wiki', name),
        `---\ntitle: ${title}\n---\n\n# ${title}\n\n[x](other.md)\n`,
      );
    await fs.mkdir(path.join(dir, 'wiki'));
    await page('a.md', 'First');
    const first = await readPages(dir);
    expect(first.map((p) => p.title)).toEqual(['First']);
    first[0].links.push('changed-by-the-caller');
    first[0].title = 'changed by the caller';
    expect((await readPages(dir))[0]).toMatchObject({
      title: 'First',
      links: ['other.md'],
    });
    await page('a.md', 'First, edited');
    await page('b.md', 'Second');
    expect((await readPages(dir)).map((p) => p.title)).toEqual([
      'First, edited',
      'Second',
    ]);
    await fs.rm(path.join(dir, 'wiki', 'a.md'));
    expect((await readPages(dir)).map((p) => p.title)).toEqual(['Second']);
  });
});
