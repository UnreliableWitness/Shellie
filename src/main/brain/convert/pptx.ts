import JSZip from 'jszip';
import type { Converted } from './types';

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&amp;/g, '&');
}

/** One line per `<a:p>`, made of its `<a:t>` runs. */
function paragraphsOf(xml: string): string[] {
  const lines: string[] = [];
  for (const p of xml.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>|<a:p\/>/g)) {
    let line = '';
    for (const t of p[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g))
      line += decode(t[1]);
    line = line.trim();
    if (line) lines.push(line);
  }
  return lines;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

type Rel = { id: string; type: string; target: string };

function parseRels(xml: string): Rel[] {
  return [...xml.matchAll(/<Relationship\s[^>]*>/g)].flatMap((m) => {
    const id = attr(m[0], 'Id');
    const type = attr(m[0], 'Type');
    const target = attr(m[0], 'Target');
    return id && type && target ? [{ id, type, target }] : [];
  });
}

/** Resolves a relationship target against the part that owns the rels file. */
function resolve(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export async function pptxToMarkdown(buf: Buffer): Promise<Converted> {
  const zip = await JSZip.loadAsync(buf);
  const read = async (p: string) =>
    (await zip.file(p)?.async('string')) ?? null;

  const presentation = (await read('ppt/presentation.xml')) ?? '';
  const presRels = parseRels(
    (await read('ppt/_rels/presentation.xml.rels')) ?? '',
  );
  const slidePaths = [...presentation.matchAll(/<p:sldId\s[^>]*>/g)].flatMap(
    (m) => {
      const rid = attr(m[0], 'r:id');
      const rel = presRels.find((r) => r.id === rid);
      return rel ? [resolve('ppt', rel.target)] : [];
    },
  );

  const sections: string[] = [];
  for (const [i, slidePath] of slidePaths.entries()) {
    const lines = paragraphsOf((await read(slidePath)) ?? '');
    const dir = slidePath.slice(0, slidePath.lastIndexOf('/'));
    const file = slidePath.slice(slidePath.lastIndexOf('/') + 1);
    const rels = parseRels((await read(`${dir}/_rels/${file}.rels`)) ?? '');
    const notesRel = rels.find((r) => r.type.endsWith('/notesSlide'));
    const notes = notesRel
      ? paragraphsOf((await read(resolve(dir, notesRel.target))) ?? '').join(
          ' ',
        )
      : '';
    const out = [`## Slide ${i + 1}`, ...lines];
    if (notes) out.push(`_Notes:_ ${notes}`);
    sections.push(out.join('\n'));
  }

  const hasImages = Object.keys(zip.files).some((f) =>
    f.startsWith('ppt/media/'),
  );
  return {
    markdown: sections.join('\n\n') + '\n',
    title: null,
    needsOcr: false,
    warnings: hasImages ? ['images dropped'] : [],
  };
}
