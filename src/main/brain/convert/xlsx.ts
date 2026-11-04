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

/** Limits tests may lower: the decompressed size of one XML part the converter is willing to read. */
export const limits = { partBytes: 64 * 1024 * 1024 };

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

/** An attribute's value, in double or single quotes. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decode(m[1] ?? m[2]) : null;
}

/** An element name with an optional namespace prefix (`c`, `x:c`), for building patterns. */
const el = (name: string) => `(?:[A-Za-z0-9_]+:)?${name}`;

/**
 * Every element of the name: self-closing, or with a body that ends at the closing tag. An open tag never
 * runs past the next `<`, and the body scan stops at the next element of the same name, so an unclosed one
 * costs one scan to its neighbour, never to the end of the part: a crafted file cannot make this quadratic.
 */
function elements(name: string): RegExp {
  const n = el(name);
  return new RegExp(
    `<${n}\\b([^<>]*?)(?:/>|>((?:(?!<${n}\\b)[\\s\\S])*?)</${n}>)`,
    'g',
  );
}

/** An open tag of the name, with its attributes (never past the next `<`). */
const openTag = (name: string) => new RegExp(`<${el(name)}\\s[^<>]*>`, 'g');

const CELLS = elements('c');
const ROWS = elements('row');
const SHARED = elements('si');
const SHEETS = openTag('sheet');
const NUMFMTS = openTag('numFmt');
const CELLXFS = elements('cellXfs');
const XFS = openTag('xf');
const VALUE = elements('v');
const TEXT = elements('t');
const PHONETIC = elements('rPh');
const DATE1904 = new RegExp(
  `<${el('workbookPr')}\\s[^<>]*\\bdate1904=["'](1|true)["']`,
);
const BLIP = /<a:blip\s[^<>]*\br:embed=(?:"([^"]*)"|'([^']*)')/g;

type Rel = { id: string; type: string; target: string; mode: string | null };

function parseRels(xml: string): Rel[] {
  return [...xml.matchAll(/<Relationship\s[^<>]*>/g)].flatMap((m) => {
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

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const fileOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const relsOf = (p: string) =>
  `${dirOf(p)}${dirOf(p) ? '/' : ''}_rels/${fileOf(p)}.rels`;

/** The text of a rich or plain string element: every `<t>` run joined, phonetic (furigana) runs left out. */
const runs = (xml: string) =>
  [...xml.replace(PHONETIC, '').matchAll(TEXT)]
    .map((m) => decode(m[2] ?? ''))
    .join('');

/** Column letters of a cell reference ("BC12" -> 54, zero based); -1 without letters. */
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

/**
 * Whether a custom format code shows a date or time: date letters outside quotes and bracket sections, no
 * digit placeholders except fractional seconds, and no elapsed-time section (`[h]`, a duration).
 */
export function isDateFormat(code: string): boolean {
  if (/\[[hms]+\]/i.test(code)) return false;
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '') // backslash-escaped literals (`\d\a\y\s`)
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\.0+/g, ''); // fractional seconds
  return /[ymdhs]/i.test(bare) && !/[#0]/.test(bare);
}

/** Which cell styles (by index in cellXfs) format a date, from styles.xml. */
function dateStyles(stylesXml: string): Set<number> {
  const custom = new Set<number>();
  for (const m of stylesXml.matchAll(NUMFMTS)) {
    const id = Number(attr(m[0], 'numFmtId'));
    if (isDateFormat(attr(m[0], 'formatCode') ?? '')) custom.add(id);
  }
  const out = new Set<number>();
  CELLXFS.lastIndex = 0;
  const xfs = CELLXFS.exec(stylesXml)?.[2] ?? '';
  [...xfs.matchAll(XFS)].forEach((m, i) => {
    const id = Number(attr(m[0], 'numFmtId') ?? '0');
    if (DATE_FORMAT_IDS.has(id) || custom.has(id)) out.add(i);
  });
  return out;
}

/**
 * An Excel serial day as an ISO date, with the time when it has one; a serial below one day is a time of
 * day. The 1900 system counts 1900-01-00 as day 0 and has the fictitious 1900-02-29 (1970-01-01 is day 25569,
 * the days before 1900-03-01 sit one earlier); the 1904 system starts at 1904-01-01 (day 24107 is 1970-01-01).
 */
export function serialToIso(serial: number, date1904 = false): string {
  const hhmm = (d: Date) => d.toISOString().slice(11, 16);
  // Below one day in the 1900 system there is no date to show, only a time; day 0 of the 1904 system is a date.
  if (!date1904 && serial >= 0 && serial < 1) {
    return hhmm(new Date(Math.round(serial * 86400 * 1000)));
  }
  const offset = date1904 ? 24107 : serial < 60 ? 25568 : 25569;
  const ms = Math.round((serial - offset) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const date = d.toISOString().slice(0, 10);
  const frac = serial - Math.floor(serial);
  return frac > 0 ? `${date} ${hhmm(d)}` : date;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** A stored number as Excel shows it: 15 significant digits, so floating-point noise goes and ids stay. */
function formatNumber(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return String(Number(n.toPrecision(15)));
}

type Sheet = { name: string; part: string; kind: 'worksheet' | 'chartsheet' };

/** The sheets in workbook order, with their part paths, from the workbook's relationships. */
function sheetsOf(
  workbookPart: string,
  workbook: string,
  rels: Rel[],
): Sheet[] {
  return [...workbook.matchAll(SHEETS)].flatMap((m) => {
    const name = attr(m[0], 'name') ?? 'Sheet';
    const rid = attr(m[0], 'r:id');
    const rel = rels.find((r) => r.id === rid);
    if (!rel) return [];
    return [
      {
        name,
        part: resolve(dirOf(workbookPart), rel.target),
        kind: rel.type.endsWith('/chartsheet') ? 'chartsheet' : 'worksheet',
      },
    ];
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
  const read = async (p: string): Promise<string | null> => {
    const file = zip.file(p);
    if (!file) return null;
    const data = await file.async('nodebuffer');
    if (data.length > limits.partBytes) {
      throw new Error(
        `The workbook part ${fileOf(p)} is too large to read (${Math.round(data.length / 1048576)} MB)`,
      );
    }
    return data.toString('utf8');
  };
  const readBinary = async (p: string) =>
    (await zip.file(p)?.async('nodebuffer')) ?? null;

  // The workbook part from the package relationships (xl/workbook.xml nearly always), its own parts from its rels.
  const pkgRels = parseRels((await read('_rels/.rels')) ?? '');
  const workbookPart =
    pkgRels
      .find((r) => r.type.endsWith('/officeDocument'))
      ?.target.replace(/^\//, '') ?? 'xl/workbook.xml';
  const workbook = await read(workbookPart);
  if (!workbook) throw new Error('Not a valid .xlsx file');
  const wbRels = parseRels((await read(relsOf(workbookPart))) ?? '');
  const partOf = async (type: string, fallback: string) => {
    const rel = wbRels.find((r) => r.type.endsWith(`/${type}`));
    return (
      (await read(rel ? resolve(dirOf(workbookPart), rel.target) : fallback)) ??
      ''
    );
  };
  const shared = [
    ...(await partOf('sharedStrings', 'xl/sharedStrings.xml')).matchAll(SHARED),
  ].map((m) => runs(m[2] ?? ''));
  const dates = dateStyles(await partOf('styles', 'xl/styles.xml'));
  const date1904 = DATE1904.test(workbook);
  const images = new ImageCollector(opts.rasterize);
  const media = new Map<string, string | null>();
  const sections: string[] = [];
  let cells = 0;

  for (const [si, sheet] of sheetsOf(
    workbookPart,
    workbook,
    wbRels,
  ).entries()) {
    if (sheet.kind === 'chartsheet') {
      sections.push(`## ${sheet.name}\n\n_(chart sheet)_`);
      continue;
    }
    const xml = (await read(sheet.part)) ?? '';
    const rows: string[][] = [];
    let skippedRows = 0;
    const skippedCols = new Set<number>();
    for (const r of xml.matchAll(ROWS)) {
      const values: string[] = [];
      let next = 0; // the column a cell without a reference takes
      for (const c of (r[2] ?? '').matchAll(CELLS)) {
        const open = `<c ${c[1]}>`;
        const body = c[2] ?? '';
        const ref = attr(open, 'r') ?? '';
        const col = ref ? columnIndex(ref) : next;
        if (col < 0) continue;
        next = col + 1;
        const t = attr(open, 't');
        const s = Number(attr(open, 's') ?? '-1');
        let text = '';
        if (t === 'inlineStr') text = runs(body);
        else {
          VALUE.lastIndex = 0;
          const v = VALUE.exec(body)?.[2];
          if (v === undefined) continue;
          if (t === 's') text = shared[Number(v)] ?? '';
          else if (t === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
          else if (t === 'd')
            text = decode(v).replace(/T00:00:00(?:\.0+)?Z?$/, '');
          else if (t === 'str' || t === 'e') text = decode(v);
          else if (dates.has(s) && Number.isFinite(Number(v)))
            text = serialToIso(Number(v), date1904);
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
    const srels = parseRels((await read(relsOf(sheet.part))) ?? '');
    for (const drel of srels.filter((r) => r.type.endsWith('/drawing'))) {
      const dpart = resolve(dirOf(sheet.part), drel.target);
      const drels = parseRels((await read(relsOf(dpart))) ?? '');
      const dxml = (await read(dpart)) ?? '';
      let k = 0;
      for (const m of dxml.matchAll(BLIP)) {
        const rel = drels.find((r) => r.id === (m[1] ?? m[2]));
        if (!rel || rel.mode === 'External') continue;
        const mediaPath = resolve(dirOf(dpart), rel.target);
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
