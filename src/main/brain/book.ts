/**
 * The brain's book: `brain/book.json` orders wiki pages into chapters. Read tolerantly, because an agent wrote it:
 * what does not hold (a page that is gone, a page twice, a back-of-the-book page) is dropped, not an error.
 */
import fs from 'node:fs/promises';
import {
  BACK_OF_BOOK_TYPES,
  type BrainBook,
  type BrainChapter,
  type BrainPageType,
} from '../../shared/brain';
import { pageType } from './browse';
import { readPages } from './pages';
import { absPath } from './paths';

export const BOOK_PATH = 'brain/book.json';

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The book in `text` against the pages that exist (`known`: path to type), or null when it is not a book: not JSON,
 * not an object, no chapters, or a chapter without a title. A page stays at its first place; a chapter left with
 * no pages is kept.
 */
export function parseBook(
  source: string,
  known: ReadonlyMap<string, BrainPageType>,
): BrainBook | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  const list = (raw as { chapters?: unknown } | null)?.chapters;
  if (!Array.isArray(list) || !list.length) return null;
  const placed = new Set<string>();
  const chapters: BrainChapter[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') return null;
    const o = c as Record<string, unknown>;
    const title = text(o.title);
    if (!title) return null;
    const pages: string[] = [];
    for (const p of Array.isArray(o.pages) ? o.pages : []) {
      if (typeof p !== 'string' || placed.has(p)) continue;
      const type = known.get(p);
      if (!type || BACK_OF_BOOK_TYPES.has(type)) continue;
      placed.add(p);
      pages.push(p);
    }
    chapters.push({
      title,
      summary: text(o.summary),
      intro: text(o.intro),
      pages,
    });
  }
  return { chapters };
}

/** The brain's book, or null when there is no file or it is not a usable book. */
export async function readBook(brainDir: string): Promise<BrainBook | null> {
  let raw: string;
  try {
    raw = await fs.readFile(absPath(brainDir, BOOK_PATH), 'utf8');
  } catch {
    return null;
  }
  const pages = await readPages(brainDir).catch(() => []);
  return parseBook(raw, new Map(pages.map((p) => [p.path, pageType(p.path)])));
}
