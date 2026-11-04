import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  MAX_COLS,
  MAX_ROWS,
  columnIndex,
  isDateFormat,
  limits,
  serialToIso,
  xlsxToMarkdown,
} from './xlsx';

const REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

type Cell = {
  r: string;
  t?: string;
  s?: number;
  v?: string;
  is?: string;
  f?: string;
};
type SheetSpec = { name: string; rows: Cell[][]; picture?: boolean };

/** A workbook from cell specs; shared strings are given as `t: 's'` with their index in `v`. */
async function buildXlsx(
  sheets: SheetSpec[],
  opts: { shared?: string[]; date1904?: boolean; sharedXml?: string } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    `<workbook xmlns:r="r">${opts.date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheets
      .map(
        (s, i) =>
          `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join('')}</sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<Relationships>${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  );
  if (opts.sharedXml) zip.file('xl/sharedStrings.xml', opts.sharedXml);
  else if (opts.shared) {
    zip.file(
      'xl/sharedStrings.xml',
      `<sst>${opts.shared.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`,
    );
  }
  zip.file(
    'xl/styles.xml',
    `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="22"/></cellXfs></styleSheet>`,
  );
  sheets.forEach((s, i) => {
    const n = i + 1;
    const rows = s.rows
      .map(
        (cells, ri) =>
          `<row r="${ri + 1}">${cells
            .map((c) => {
              const t = c.is !== undefined ? 'inlineStr' : c.t;
              const attrs = `r="${c.r}"${t ? ` t="${t}"` : ''}${c.s !== undefined ? ` s="${c.s}"` : ''}`;
              if (c.is !== undefined)
                return `<c ${attrs}><is><t>${c.is}</t></is></c>`;
              if (c.v === undefined) return `<c ${attrs}/>`;
              return `<c ${attrs}>${c.f ? `<f>${c.f}</f>` : ''}<v>${c.v}</v></c>`;
            })
            .join('')}</row>`,
      )
      .join('');
    zip.file(
      `xl/worksheets/sheet${n}.xml`,
      `<worksheet xmlns:r="r"><sheetData>${rows}</sheetData>${s.picture ? '<drawing r:id="rId1"/>' : ''}</worksheet>`,
    );
    if (s.picture) {
      zip.file(
        `xl/worksheets/_rels/sheet${n}.xml.rels`,
        `<Relationships><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing${n}.xml"/></Relationships>`,
      );
      zip.file(
        `xl/drawings/drawing${n}.xml`,
        '<xdr:wsDr xmlns:a="a" xmlns:r="r"><xdr:pic><a:blip r:embed="rId1"/></xdr:pic></xdr:wsDr>',
      );
      zip.file(
        `xl/drawings/_rels/drawing${n}.xml.rels`,
        `<Relationships><Relationship Id="rId1" Type="${REL}/image" Target="../media/image1.png"/></Relationships>`,
      );
      zip.file('xl/media/image1.png', PNG);
    }
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('xlsxToMarkdown', () => {
  it('renders each sheet as a markdown table with strings, numbers, booleans, dates and formula values', async () => {
    const r = await xlsxToMarkdown(
      await buildXlsx(
        [
          {
            name: 'Budget 2026',
            rows: [
              [
                { r: 'A1', t: 's', v: '0' },
                { r: 'B1', t: 's', v: '1' },
                { r: 'C1', is: 'Paid' },
                { r: 'D1', t: 's', v: '2' },
              ],
              [
                { r: 'A2', t: 's', v: '3' },
                { r: 'B2', v: '1250.5' },
                { r: 'C2', t: 'b', v: '1' },
                { r: 'D2', s: 1, v: '46023' },
              ],
              [],
              [
                { r: 'A4', t: 's', v: '4' },
                { r: 'B4', f: 'SUM(B2:B3)', v: '1250.5' },
                { r: 'C4', t: 'b', v: '0' },
                { r: 'D4', s: 4, v: '46023.5' },
              ],
            ],
          },
          {
            name: 'Notes',
            rows: [[{ r: 'B2', t: 'str', v: 'Rates | per day' }]],
          },
        ],
        { shared: ['Item', 'EUR', 'Due', 'Licences', 'Total'] },
      ),
    );
    expect(r.markdown).toBe(
      [
        '## Budget 2026',
        '',
        '| Item | EUR | Paid | Due |',
        '| --- | --- | --- | --- |',
        '| Licences | 1250.5 | TRUE | 2026-01-01 |',
        '| Total | 1250.5 | FALSE | 2026-01-01 12:00 |',
        '',
        '## Notes',
        '',
        '|  | Rates \\| per day |',
        '| --- | --- |',
        '',
      ].join('\n'),
    );
    expect(r.empty).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('formats custom date styles as dates and leaves number formats alone', async () => {
    const r = await xlsxToMarkdown(
      await buildXlsx([
        {
          name: 'S',
          rows: [
            [
              { r: 'A1', s: 2, v: '45000' },
              { r: 'B1', s: 3, v: '45000' },
              { r: 'C1', v: '0.30000000000000004' },
            ],
          ],
        },
      ]),
    );
    expect(r.markdown).toContain('| 2023-03-15 | 45000 | 0.3 |');
  });

  it('caps rows and columns and says how many were left', async () => {
    const rows: Cell[][] = [];
    for (let i = 0; i < MAX_ROWS + 3; i++)
      rows.push([{ r: `A${i + 1}`, v: String(i) }]);
    rows[0].push({ r: 'BA1', v: '52' }, { r: 'BB1', v: '53' });
    const r = await xlsxToMarkdown(await buildXlsx([{ name: 'Big', rows }]));
    expect(r.markdown.match(/^\| /gm)).toHaveLength(MAX_ROWS + 1);
    expect(r.markdown).toContain(`_3 more rows not shown (limit ${MAX_ROWS})_`);
    expect(r.markdown).toContain(
      `_2 more columns not shown (limit ${MAX_COLS})_`,
    );
    // The first row keeps only its first column.
    expect(r.markdown).toContain('## Big\n\n| 0 |\n| --- |\n| 1 |');
  });

  it('takes the pictures placed on a sheet', async () => {
    const r = await xlsxToMarkdown(
      await buildXlsx([
        { name: 'Plan', rows: [[{ r: 'A1', is: 'x' }]], picture: true },
      ]),
    );
    expect(r.images.map((i) => i.name)).toEqual(['sheet-1-1.png']);
    expect(r.markdown).toContain('![Plan picture 1]({{assets}}/sheet-1-1.png)');
  });

  it('is empty without cells or pictures, and marks an empty sheet', async () => {
    const r = await xlsxToMarkdown(
      await buildXlsx([{ name: 'Blank', rows: [] }]),
    );
    expect(r.empty).toBe(true);
    expect(r.markdown).toContain('## Blank\n\n_(empty sheet)_');
  });

  it('rejects garbage and a zip without a workbook', async () => {
    await expect(xlsxToMarkdown(Buffer.from('nope'))).rejects.toThrow(
      'Not a valid .xlsx file',
    );
    const zip = new JSZip();
    zip.file('x.txt', 'x');
    await expect(
      xlsxToMarkdown(await zip.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toThrow('Not a valid .xlsx file');
  });

  it('keeps 15 significant digits, so ids stored as numbers survive', async () => {
    const r = await xlsxToMarkdown(
      await buildXlsx([
        {
          name: 'Ids',
          rows: [
            [
              { r: 'A1', v: '5901234123457' },
              { r: 'B1', v: '123456789012345' },
              { r: 'C1', v: '1E+16' },
            ],
          ],
        },
      ]),
    );
    expect(r.markdown).toContain(
      '| 5901234123457 | 123456789012345 | 10000000000000000 |',
    );
  });

  it('honours the 1904 date system', async () => {
    const r = await xlsxToMarkdown(
      await buildXlsx(
        [
          {
            name: 'S',
            rows: [
              [
                { r: 'A1', s: 1, v: '0' },
                { r: 'B1', s: 1, v: '44561' },
              ],
            ],
          },
        ],
        {
          date1904: true,
        },
      ),
    );
    expect(r.markdown).toContain('| 1904-01-01 | 2026-01-01 |');
  });

  it('reads prefixed elements, cells without a reference and single-quoted attributes', async () => {
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      `<x:workbook xmlns:x="x" xmlns:r="r"><x:sheets><x:sheet name='Data' sheetId='1' r:id='rId1'/></x:sheets></x:workbook>`,
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<Relationships><Relationship Id='rId1' Type='${REL}/worksheet' Target='worksheets/sheet1.xml'/></Relationships>`,
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<x:worksheet xmlns:x="x"><x:sheetData><x:row><x:c t='str'><x:v>a</x:v></x:c><x:c><x:v>1</x:v></x:c><x:c r='D1'><x:v>2</x:v></x:c><x:c><x:v>3</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
    );
    const r = await xlsxToMarkdown(
      await zip.generateAsync({ type: 'nodebuffer' }),
    );
    expect(r.markdown).toContain('## Data\n\n| a | 1 |  | 2 | 3 |');
  });

  it('leaves out phonetic runs and reads a self-closing shared string entry', async () => {
    const r = await xlsxToMarkdown(
      await buildXlsx(
        [
          {
            name: 'S',
            rows: [
              [
                { r: 'A1', t: 's', v: '0' },
                { r: 'B1', t: 's', v: '2' },
              ],
            ],
          },
        ],
        {
          sharedXml:
            '<sst><si><r><t>東京</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si><si/><si><t xml:space="preserve"> after empty</t></si></sst>',
        },
      ),
    );
    expect(r.markdown).toContain('| 東京 | after empty |');
  });

  it('shows times of day, leaves durations as numbers and reads ISO date cells', async () => {
    const r = await xlsxToMarkdown(
      await buildXlsx([
        {
          name: 'T',
          rows: [
            [
              { r: 'A1', s: 4, v: '0.5' },
              { r: 'B1', t: 'd', v: '2024-03-01T00:00:00Z' },
              { r: 'C1', s: 2, v: '45000.5' },
            ],
          ],
        },
      ]),
    );
    expect(r.markdown).toContain('| 12:00 | 2024-03-01 | 2023-03-15 12:00 |');
    expect(isDateFormat('[h]:mm')).toBe(false);
    expect(isDateFormat('yyyy-mm-dd hh:mm:ss.000')).toBe(true);
    expect(isDateFormat('[DBNum1]#,##0')).toBe(false);
    expect(isDateFormat('"Total" #,##0.00')).toBe(false);
    expect(isDateFormat('h:mm')).toBe(true);
  });

  it('marks a chart sheet and refuses a part over the size limit', async () => {
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      '<workbook xmlns:r="r"><sheets><sheet name="Chart" sheetId="1" r:id="rId1"/><sheet name="Data" sheetId="2" r:id="rId2"/></sheets></workbook>',
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<Relationships><Relationship Id="rId1" Type="${REL}/chartsheet" Target="chartsheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    );
    zip.file('xl/chartsheets/sheet1.xml', '<chartsheet/>');
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row><c r="A1" t="str"><v>x</v></c></row></sheetData></worksheet>',
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const r = await xlsxToMarkdown(buf);
    expect(r.markdown).toContain('## Chart\n\n_(chart sheet)_\n\n## Data');
    const before = limits.partBytes;
    limits.partBytes = 50;
    try {
      await expect(xlsxToMarkdown(buf)).rejects.toThrow(/too large to read/);
    } finally {
      limits.partBytes = before;
    }
  });

  it('parses a sheet full of unclosed cells in linear time', async () => {
    const cells = Array.from(
      { length: 32_000 },
      (_, i) => `<c r="A${i + 1}"><v>${i}</v>`,
    ).join('');
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<worksheet><sheetData><row>${cells}</sheetData></worksheet>`,
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const t0 = Date.now();
    await xlsxToMarkdown(buf);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('parses crafted open tags, text runs and style blocks in linear time', async () => {
    const zip = new JSZip();
    const many = (tag: string, n: number) =>
      Array.from({ length: n }, () => tag).join('');
    zip.file(
      'xl/workbook.xml',
      `<workbook xmlns:r="r">${many('<workbookPr ', 32_000)}<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    );
    zip.file(
      'xl/sharedStrings.xml',
      `<sst><si>${many('<t>', 32_000)}</si><si><t>${many('<rPh>', 32_000)}</t></si></sst>`,
    );
    zip.file(
      'xl/styles.xml',
      `<styleSheet>${many('<cellXfs>', 32_000)}</styleSheet>`,
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="str"><v>x</v></c></row></sheetData></worksheet>',
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const t0 = Date.now();
    const r = await xlsxToMarkdown(buf);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.markdown).toContain('| x |');
  });

  it('does not take backslash-escaped letters in a number format for a date', () => {
    expect(isDateFormat('General\\ \\d\\a\\y\\s')).toBe(false);
    expect(isDateFormat('0\\ \\h')).toBe(false);
    expect(isDateFormat('dd\\.mm\\.yyyy')).toBe(true);
  });

  it('reads column letters and Excel serial dates', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA1')).toBe(26);
    expect(columnIndex('BC12')).toBe(54);
    expect(serialToIso(1)).toBe('1900-01-01');
    expect(serialToIso(46023)).toBe('2026-01-01');
    expect(serialToIso(46023.75)).toBe('2026-01-01 18:00');
    expect(serialToIso(0.75)).toBe('18:00');
    expect(serialToIso(0, true)).toBe('1904-01-01');
  });
});
