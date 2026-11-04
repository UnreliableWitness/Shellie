import JSZip from 'jszip';
import {
  ImageCollector,
  imageExt,
  type ConvertOptions,
  type Converted,
} from './types';

/** Rows kept per sheet, and columns per row; the rest is counted in a note. */
export const MAX_ROWS = 500;
export const MAX_COLS = 50;

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

function resolve(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** The text of a rich or plain string element: every `<t>` run joined. */
const runs = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((m) => decode(m[1]))
    .join('');

/** Column letters of a cell reference ("BC12" -> 54, zero based). */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch < 'A' || ch > 'Z') break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** Built-in number formats that mean a date or time (ECMA-376 18.8.30). */
const DATE_FORMAT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** Which cell styles (by index in cellXfs) format a date, from styles.xml. */
function dateStyles(stylesXml: string): Set<number> {
  const custom = new Set<number>();
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = (attr(m[0], 'formatCode') ?? '').replace(/"[^"]*"/g, '');
    if (/[ymdh]/i.test(code) && !/[#0]/.test(code)) custom.add(id);
  }
  const out = new Set<number>();
  const xfs = /<cellXfs[\s>][\s\S]*?<\/cellXfs>/.exec(stylesXml)?.[0] ?? '';
  [...xfs.matchAll(/<xf\s[^>]*\/?>/g)].forEach((m, i) => {
    const id = Number(attr(m[0], 'numFmtId') ?? '0');
    if (DATE_FORMAT_IDS.has(id) || custom.has(id)) out.add(i);
  });
  return out;
}

/** An Excel serial day (1900 system) as an ISO date, with the time when it has one. */
export function serialToIso(serial: number): string {
  // Excel counts 1900-01-00 as day 0 and has the fictitious 1900-02-29: 1970-01-01 is day 25569, and the
  // days before 1900-03-01 sit one day earlier.
  const offset = serial < 60 ? 25568 : 25569;
  const ms = Math.round((serial - offset) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const date = d.toISOString().slice(0, 10);
  const frac = serial - Math.floor(serial);
  return frac > 0 ? `${date} ${d.toISOString().slice(11, 16)}` : date;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function formatNumber(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  // Floating-point noise from the file (0.30000000000000004) is not worth keeping.
  return String(Number(n.toPrecision(12)));
}

type Sheet = { name: string; part: string };

/** The sheets in workbook order, with their part paths. */
async function sheetsOf(
  read: (p: string) => Promise<string | null>,
): Promise<Sheet[]> {
  const workbook = (await read('xl/workbook.xml')) ?? '';
  const rels = parseRels((await read('xl/_rels/workbook.xml.rels')) ?? '');
  return [...workbook.matchAll(/<sheet\s[^>]*>/g)].flatMap((m) => {
    const name = attr(m[0], 'name') ?? 'Sheet';
    const rid = attr(m[0], 'r:id');
    const rel = rels.find((r) => r.id === rid);
    return rel ? [{ name, part: resolve('xl', rel.target) }] : [];
  });
}

export async function xlsxToMarkdown(
  buf: Buffer,
  opts: ConvertOptions = {},
): Promise<Converted> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (err) {
    throw new Error('Not a valid .xlsx file', { cause: err });
  }
  const read = async (p: string) =>
    (await zip.file(p)?.async('string')) ?? null;
  const readBinary = async (p: string) =>
    (await zip.file(p)?.async('nodebuffer')) ?? null;
  if (!(await read('xl/workbook.xml'))) {
    throw new Error('Not a valid .xlsx file');
  }

  const shared = [
    ...((await read('xl/sharedStrings.xml')) ?? '').matchAll(
      /<si>([\s\S]*?)<\/si>/g,
    ),
  ].map((m) => runs(m[1]));
  const dates = dateStyles((await read('xl/styles.xml')) ?? '');
  const images = new ImageCollector(opts.rasterize);
  const media = new Map<string, string | null>();
  const sections: string[] = [];
  let cells = 0;

  for (const [si, sheet] of (await sheetsOf(read)).entries()) {
    const xml = (await read(sheet.part)) ?? '';
    const rows: string[][] = [];
    let skippedRows = 0;
    const skippedCols = new Set<number>();
    for (const r of xml.matchAll(/<row\s[^>]*>([\s\S]*?)<\/row>/g)) {
      const values: string[] = [];
      for (const c of r[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const open = c[1];
        const body = c[2] ?? '';
        const ref = attr(`<c ${open}>`, 'r') ?? '';
        const col = columnIndex(ref);
        if (col < 0) continue;
        const t = attr(`<c ${open}>`, 't');
        const s = Number(attr(`<c ${open}>`, 's') ?? '-1');
        let text = '';
        if (t === 'inlineStr') text = runs(body);
        else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          if (v === undefined) continue;
          if (t === 's') text = shared[Number(v)] ?? '';
          else if (t === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
          else if (t === 'str' || t === 'e') text = decode(v);
          else if (dates.has(s) && Number.isFinite(Number(v)))
            text = serialToIso(Number(v));
          else text = formatNumber(decode(v));
        }
        if (text === '') continue;
        if (col >= MAX_COLS) {
          skippedCols.add(col);
          continue;
        }
        while (values.length < col) values.push('');
        values[col] = text;
        cells++;
      }
      if (values.length === 0) continue;
      if (rows.length >= MAX_ROWS) {
        skippedRows++;
        continue;
      }
      rows.push(values);
    }

    const pictures: string[] = [];
    const sdir = sheet.part.slice(0, sheet.part.lastIndexOf('/'));
    const sfile = sheet.part.slice(sheet.part.lastIndexOf('/') + 1);
    const srels = parseRels((await read(`${sdir}/_rels/${sfile}.rels`)) ?? '');
    for (const drel of srels.filter((r) => r.type.endsWith('/drawing'))) {
      const dpart = resolve(sdir, drel.target);
      const ddir = dpart.slice(0, dpart.lastIndexOf('/'));
      const dfile = dpart.slice(dpart.lastIndexOf('/') + 1);
      const drels = parseRels(
        (await read(`${ddir}/_rels/${dfile}.rels`)) ?? '',
      );
      const dxml = (await read(dpart)) ?? '';
      let k = 0;
      for (const m of dxml.matchAll(/<a:blip\s[^>]*\br:embed="([^"]*)"/g)) {
        const rel = drels.find((r) => r.id === m[1]);
        if (!rel || rel.mode === 'External') continue;
        const mediaPath = resolve(ddir, rel.target);
        k++;
        if (!media.has(mediaPath)) {
          const data = await readBinary(mediaPath);
          media.set(
            mediaPath,
            data
              ? await images.addAny(
                  `sheet-${si + 1}-${k}`,
                  data,
                  imageExt(mediaPath),
                )
              : null,
          );
        }
        const ref = media.get(mediaPath);
        if (ref) pictures.push(`![${sheet.name} picture ${k}](${ref})`);
      }
    }

    const out = [`## ${sheet.name}`];
    if (rows.length > 0) {
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) =>
        [...r, ...Array<string>(width - r.length).fill('')]
          .map(cell)
          .join(' | ');
      out.push(
        '',
        `| ${pad(rows[0])} |`,
        `| ${Array<string>(width).fill('---').join(' | ')} |`,
        ...rows.slice(1).map((r) => `| ${pad(r)} |`),
      );
    } else if (pictures.length === 0) out.push('', '_(empty sheet)_');
    if (skippedRows > 0) {
      out.push('', `_${skippedRows} more rows not shown (limit ${MAX_ROWS})_`);
    }
    if (skippedCols.size > 0) {
      out.push(
        '',
        `_${skippedCols.size} more columns not shown (limit ${MAX_COLS})_`,
      );
    }
    if (pictures.length) out.push('', ...pictures);
    sections.push(out.join('\n'));
  }

  return {
    markdown: sections.join('\n\n') + '\n',
    title: null,
    images: images.images,
    warnings: images.warnings(),
    empty: cells === 0 && images.images.length === 0,
  };
}
