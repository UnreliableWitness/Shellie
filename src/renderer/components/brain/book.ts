import type { BrainBook, BrainPageRow } from '../../../shared/brain';

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const TITLE = /^\s*# [^\n]*(?:\n|$)/;

/** The chapter holding the page, or -1 (a page of the back of the book, or no book). */
export const chapterOf = (book: BrainBook, path: string): number =>
  book.chapters.findIndex((c) => c.pages.includes(path));

/** The element id of the nth section of a chapter. */
export const sectionId = (n: number): string => `section-${n}`;

/** The pictures the pages before the nth already show: a picture is shown once per chapter, at its first mention. */
export function shownBefore(
  rows: BrainPageRow[],
  pages: string[],
  n: number,
): Set<string> {
  const shown = new Set<string>();
  for (const p of pages.slice(0, n))
    for (const pic of rows.find((r) => r.path === p)?.pictures ?? [])
      shown.add(pic);
  return shown;
}

/** A page's text as a section body: the frontmatter and a leading `# ` heading off (the section's header has the title). */
export const stripTitle = (text: string): string =>
  text.replace(FRONTMATTER, '').replace(TITLE, '');

/**
 * The section being read: the last whose top is above the scroller's top plus a third of its height, the first when
 * none is, and the last section once the scroller is at its end (a short last section never gets that high). Without
 * layout (a zero-height scroller) it is `fallback`.
 */
export function sectionBeingRead(
  sections: Element[],
  scroller: Element,
  fallback: number,
): number {
  const box = scroller.getBoundingClientRect();
  if (box.height === 0) return fallback;
  const room = scroller.scrollHeight - scroller.clientHeight;
  if (room > 0 && scroller.scrollTop >= room - 2)
    return Math.max(sections.length - 1, 0);
  const line = box.top + box.height / 3;
  let read = 0;
  sections.forEach((s, i) => {
    if (s.getBoundingClientRect().top <= line) read = i;
  });
  return read;
}
