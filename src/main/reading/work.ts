/**
 * Which long read bears on which work item. Nothing in a brain links a page to a work item, so the link is made by
 * words, the way the task's Brain tab finds its relevant pages.
 */
import type { BrainPageRow, BrainReadRow } from '../../shared/brain';
import type { ReadWork } from '../../shared/reading';
import { relevantPages, taskWords } from '../brain/browse';

/** A work item in front of the reader; `name` is its task's name when it has a task. */
export type WorkItem = { id: number; title: string; name?: string };

/** A long read is an item's only from this score on: a title word and something more. */
const ENOUGH = 3;

type Scored = { path: string; title: string; score: number; pages: number };

/**
 * One long read per item, or none: 2 for each of the item's words in the long read's title, 1 for each in its
 * summary, 1 for each of the item's most relevant pages the long read was written from (`under`).
 */
export function workFor(
  items: WorkItem[],
  reads: Pick<BrainReadRow, 'path' | 'title' | 'summary'>[],
  under: Record<string, string[]>,
  rows: BrainPageRow[],
): ReadWork {
  const out: ReadWork = {};
  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const words = taskWords([item.title, item.name ?? '']);
    if (!words.length) continue;
    const top = new Set(relevantPages(rows, words));
    let best: Scored | null = null;
    for (const r of reads) {
      const title = r.title.toLowerCase();
      const summary = r.summary.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (title.includes(w)) score += 2;
        if (summary.includes(w)) score += 1;
      }
      const pages = (under[r.path] ?? []).filter((p) => top.has(p)).length;
      score += pages;
      if (score < ENOUGH) continue;
      if (
        !best ||
        score > best.score ||
        (score === best.score &&
          (pages > best.pages ||
            (pages === best.pages && r.title.localeCompare(best.title) < 0)))
      )
        best = { path: r.path, title: r.title, score, pages };
    }
    if (best) (out[best.path] ??= []).push({ id: item.id, title: item.title });
  }
  return out;
}
