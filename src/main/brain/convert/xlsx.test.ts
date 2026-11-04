import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  MAX_COLS,
  MAX_ROWS,
  columnIndex,
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
  opts: { shared?: string[]; dateStyle?: boolean } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    `<workbook xmlns:r="r"><sheets>${sheets
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
  if (opts.shared) {
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

  it('reads column letters and Excel serial dates', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA1')).toBe(26);
    expect(columnIndex('BC12')).toBe(54);
    expect(serialToIso(1)).toBe('1900-01-01');
    expect(serialToIso(46023)).toBe('2026-01-01');
    expect(serialToIso(46023.75)).toBe('2026-01-01 18:00');
  });
});
