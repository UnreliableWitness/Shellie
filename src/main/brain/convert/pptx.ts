import JSZip from 'jszip';
import { ImageCollector, VIEWABLE, imageExt, type Converted } from './types';

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
  return m ? decode(m[1]) : null;
}

type Rel = { id: string; type: string; target: string; mode: string | null };

function parseRels(xml: string): Rel[] {
  return [...xml.matchAll(/<Relationship\s[^>]*>/g)].flatMap((m) => {
    const id = attr(m[0], 'Id');
    const type = attr(m[0], 'Type');
    const target = attr(m[0], 'Target');
    const mode = attr(m[0], 'TargetMode');
    return id && type && target ? [{ id, type, target, mode }] : [];
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

/** Notes body only: the slide-number/header placeholders are not notes. */
function notesOf(xml: string): string {
  const shapes = xml.match(/<p:sp[\s>][\s\S]*?<\/p:sp>/g) ?? [];
  const bodies = shapes.filter((s) => /<p:ph\b[^>]*\btype="body"/.test(s));
  const chosen =
    bodies.length > 0 ? bodies : shapes.filter((s) => !/<p:ph\b/.test(s));
  return chosen.flatMap(paragraphsOf).join(' ');
}

const cell = (s: string) => s.replace(/\|/g, '\\|');

function tableOf(xml: string): string[] {
  const rows = [...xml.matchAll(/<a:tr[\s>][\s\S]*?<\/a:tr>/g)].map((r) =>
    [...r[0].matchAll(/<a:tc[\s>][\s\S]*?<\/a:tc>|<a:tc\/>/g)].map((c) =>
      cell(paragraphsOf(c[0]).join(' ')),
    ),
  );
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) =>
    [...r, ...Array<string>(width - r.length).fill('')].join(' | ');
  return [
    `| ${pad(rows[0])} |`,
    `| ${Array<string>(width).fill('---').join(' | ')} |`,
    ...rows.slice(1).map((r) => `| ${pad(r)} |`),
  ];
}

/** SmartArt labels, in the order the data part lists them. */
function smartArtOf(dataXml: string): string[] {
  const labels: string[] = [];
  for (const pt of dataXml.matchAll(/<dgm:pt[\s>][\s\S]*?<\/dgm:pt>/g)) {
    const open = /<dgm:pt[^>]*>/.exec(pt[0])?.[0] ?? '';
    const type = attr(open, 'type') ?? 'node';
    if (type !== 'node' && type !== 'asst') continue;
    const text = paragraphsOf(pt[0]).join(' ');
    if (text) labels.push(text);
  }
  return labels.length ? ['_SmartArt:_', ...labels.map((l) => `- ${l}`)] : [];
}

const values = (xml: string | undefined) =>
  xml
    ? [...xml.matchAll(/<c:pt\s[^>]*>\s*<c:v>([\s\S]*?)<\/c:v>/g)].map((m) =>
        decode(m[1]).trim(),
      )
    : [];

const first = (xml: string, re: RegExp) => re.exec(xml)?.[1];

/** A chart as its title and one table row per series. */
function chartOf(chartXml: string): string[] {
  const titleXml = first(chartXml, /<c:title>([\s\S]*?)<\/c:title>/);
  const title = titleXml ? paragraphsOf(titleXml).join(' ') : '';
  const series = [...chartXml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map(
    (m) => {
      const s = m[1];
      const name =
        values(first(s, /<c:tx>([\s\S]*?)<\/c:tx>/))[0] ??
        first(s, /<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/) ??
        '';
      const cats = values(
        first(s, /<c:cat>([\s\S]*?)<\/c:cat>/) ??
          first(s, /<c:xVal>([\s\S]*?)<\/c:xVal>/),
      );
      const vals = values(
        first(s, /<c:val>([\s\S]*?)<\/c:val>/) ??
          first(s, /<c:yVal>([\s\S]*?)<\/c:yVal>/),
      );
      return { name: decode(name).trim(), cats, vals };
    },
  );
  const out = [`_Chart${title ? `: ${title}` : ''}_`];
  if (series.length === 0) return title ? out : [];
  const cats = series.find((s) => s.cats.length)?.cats ?? [];
  const width = Math.max(cats.length, ...series.map((s) => s.vals.length));
  const header = Array.from({ length: width }, (_, i) => cats[i] ?? '');
  out.push(
    `| ${['', ...header.map(cell)].join(' | ')} |`,
    `| ${Array<string>(width + 1)
      .fill('---')
      .join(' | ')} |`,
    ...series.map(
      (s) =>
        `| ${[
          cell(s.name),
          ...Array.from({ length: width }, (_, i) => cell(s.vals[i] ?? '')),
        ].join(' | ')} |`,
    ),
  );
  return out;
}

type SlideCtx = {
  n: number;
  dir: string;
  rels: Rel[];
  read: (p: string) => Promise<string | null>;
  readBinary: (p: string) => Promise<Buffer | null>;
  images: ImageCollector;
  /** media path -> markdown ref (or null when it could not be taken) */
  media: Map<string, string | null>;
  pictures: number;
};

async function pictureOf(ctx: SlideCtx, xml: string): Promise<string[]> {
  const rid = first(xml, /<a:blip\s[^>]*\br:embed="([^"]*)"/);
  if (!rid) return [];
  const rel = ctx.rels.find((r) => r.id === rid);
  if (!rel || rel.mode === 'External') return [];
  const mediaPath = resolve(ctx.dir, rel.target);
  ctx.pictures++;
  const k = ctx.pictures;
  const descr = first(xml, /<p:cNvPr\s[^>]*\bdescr="([^"]*)"/);
  const alt = descr ? decode(descr).trim() : '';
  const ext = imageExt(mediaPath);
  if (!VIEWABLE.has(ext)) {
    ctx.images.skip(ext);
    return [
      `_Picture ${k} (${ext || 'unknown format'}) could not be extracted_`,
    ];
  }
  if (!ctx.media.has(mediaPath)) {
    const data = await ctx.readBinary(mediaPath);
    ctx.media.set(
      mediaPath,
      data
        ? ctx.images.add(
            `slide-${ctx.n}-${k}.${ext === 'jpeg' ? 'jpg' : ext}`,
            data,
          )
        : null,
    );
  }
  const ref = ctx.media.get(mediaPath);
  if (!ref) return [];
  return [`![${alt || `Slide ${ctx.n} picture ${k}`}](${ref})`];
}

async function graphicFrameOf(ctx: SlideCtx, xml: string): Promise<string[]> {
  if (/<a:tbl[\s>]/.test(xml)) return tableOf(xml);
  const dm = first(xml, /<dgm:relIds\s[^>]*\br:dm="([^"]*)"/);
  if (dm) {
    const rel = ctx.rels.find((r) => r.id === dm);
    const data = rel ? await ctx.read(resolve(ctx.dir, rel.target)) : null;
    return data ? smartArtOf(data) : [];
  }
  const chart = first(xml, /<c:chart\s[^>]*\br:id="([^"]*)"/);
  if (chart) {
    const rel = ctx.rels.find((r) => r.id === chart);
    const data = rel ? await ctx.read(resolve(ctx.dir, rel.target)) : null;
    return data ? chartOf(data) : [];
  }
  // An embedded object's preview picture.
  const pic = first(xml, /(<p:pic[\s>][\s\S]*?<\/p:pic>)/);
  return pic ? pictureOf(ctx, pic) : [];
}

async function slideLines(ctx: SlideCtx, xml: string): Promise<string[]> {
  // mc:Fallback repeats mc:Choice in an older form.
  const body = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  const out: string[] = [];
  for (const m of body.matchAll(
    /<p:(sp|pic|graphicFrame)[\s>][\s\S]*?<\/p:\1>/g,
  )) {
    if (m[1] === 'sp') out.push(...paragraphsOf(m[0]));
    else if (m[1] === 'pic') out.push(...(await pictureOf(ctx, m[0])));
    else out.push(...(await graphicFrameOf(ctx, m[0])));
  }
  return out;
}

export async function pptxToMarkdown(buf: Buffer): Promise<Converted> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (err) {
    throw new Error('Not a valid .pptx file', { cause: err });
  }
  const read = async (p: string) =>
    (await zip.file(p)?.async('string')) ?? null;
  const readBinary = async (p: string) =>
    (await zip.file(p)?.async('nodebuffer')) ?? null;

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

  const images = new ImageCollector();
  const media = new Map<string, string | null>();
  const sections: string[] = [];
  let text = 0;
  for (const [i, slidePath] of slidePaths.entries()) {
    const dir = slidePath.slice(0, slidePath.lastIndexOf('/'));
    const file = slidePath.slice(slidePath.lastIndexOf('/') + 1);
    const rels = parseRels((await read(`${dir}/_rels/${file}.rels`)) ?? '');
    const ctx: SlideCtx = {
      n: i + 1,
      dir,
      rels,
      read,
      readBinary,
      images,
      media,
      pictures: 0,
    };
    const lines = await slideLines(ctx, (await read(slidePath)) ?? '');
    const notesRel = rels.find((r) => r.type.endsWith('/notesSlide'));
    const notes = notesRel
      ? notesOf((await read(resolve(dir, notesRel.target))) ?? '')
      : '';
    const out = [`## Slide ${i + 1}`, ...lines];
    if (notes) out.push(`_Notes:_ ${notes}`);
    text += lines.join('').length + notes.length;
    sections.push(out.join('\n'));
  }

  return {
    markdown: sections.join('\n\n') + '\n',
    title: null,
    images: images.images,
    warnings: images.warnings(),
    empty: text === 0 && images.images.length === 0,
  };
}
