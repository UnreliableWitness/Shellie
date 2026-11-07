/**
 * An XML file as markdown: the text as it is in an ```xml block, so Claude reads the markup unchanged. The fence
 * is longer than any backtick run in the file, so the content cannot close it early.
 */
export function xmlToMarkdown(xml: string): string {
  const text = xml.replace(/^﻿/, '').trimEnd();
  if (text.trim() === '') return '';
  const longest = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (m) => m[0].length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}xml\n${text}\n${fence}\n`;
}

/** The name of the first element, past the declaration, comments, doctype and processing instructions. */
export function xmlRoot(xml: string): string | null {
  const rest = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<![^>]*>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  return /<([A-Za-z_][\w.:-]*)/.exec(rest)?.[1] ?? null;
}
