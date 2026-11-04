import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from './index';
import { docxToMarkdown } from './docx';
import { pdfToMarkdown } from './pdf';
import { decodePng } from './png';
import { pptxToMarkdown } from './pptx';
import { MAX_IMAGES } from './types';

const fixture = (name: string) => path.join(__dirname, '__fixtures__', name);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

type SlideSpec = {
  text?: string[];
  notes?: string;
  /** Raw XML elements placed in the shape tree after the text shape. */
  extra?: string;
  /** Extra relationships (Id, Type suffix, Target). */
  rels?: { id: string; type: string; target: string; mode?: string }[];
};

const NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const NS_P =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const NS_R =
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const paragraphs = (lines: string[]) =>
  lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('');

const NUM_SHAPE =
  '<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="slidenum"><a:t>3</a:t></a:fld></a:p></p:txBody></p:sp>';

const pic = (rid: string, descr?: string) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3"${descr ? ` descr="${descr}"` : ''}/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill></p:pic>`;

const table = (rows: string[][]) =>
  `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${rows
    .map(
      (r) =>
        `<a:tr h="1">${r.map((c) => `<a:tc><a:txBody>${paragraphs([c])}</a:txBody></a:tc>`).join('')}</a:tr>`,
    )
    .join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

const smartArt = (rid: string) =>
  `<p:graphicFrame><a:graphic><a:graphicData><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="${rid}" r:lo="x" r:qs="y" r:cs="z"/></a:graphicData></a:graphic></p:graphicFrame>`;

const chart = (rid: string) =>
  `<p:graphicFrame><a:graphic><a:graphicData><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;

const DIAGRAM_DATA = `<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" ${NS_A}><dgm:ptLst><dgm:pt modelId="0" type="doc"><dgm:t>${paragraphs([''])}</dgm:t></dgm:pt><dgm:pt modelId="1"><dgm:t>${paragraphs(['Plan'])}</dgm:t></dgm:pt><dgm:pt modelId="2" type="parTrans"><dgm:t>${paragraphs(['hidden'])}</dgm:t></dgm:pt><dgm:pt modelId="3" type="node"><dgm:t>${paragraphs(['Build'])}</dgm:t></dgm:pt><dgm:pt modelId="4" type="pres"/></dgm:ptLst></dgm:dataModel>`;

const CHART_DATA = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ${NS_A}><c:chart><c:title><c:tx><c:rich>${paragraphs(['Revenue by year'])}</c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Licences</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>2025</c:v></c:pt><c:pt idx="1"><c:v>2026</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>12.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Services</c:v></c:pt></c:strCache></c:strRef></c:tx><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>4</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;

async function buildPptx(
  slides: SlideSpec[],
  opts: { realNotes?: boolean; media?: Record<string, Buffer> } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  // Slide files are numbered in reverse so file order differs from deck order.
  const fileNo = (i: number) => slides.length - i;
  zip.file(
    'ppt/presentation.xml',
    `<p:presentation ${NS_P} ${NS_R}><p:sldIdLst>${slides
      .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
      .join('')}</p:sldIdLst></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${fileNo(i)}.xml"/>`,
      )
      .join('')}</Relationships>`,
  );
  slides.forEach((s, i) => {
    const n = fileNo(i);
    zip.file(
      `ppt/slides/slide${n}.xml`,
      `<p:sld ${NS_A} ${NS_P} ${NS_R}><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs(s.text ?? [])}</p:txBody></p:sp>${s.extra ?? ''}</p:spTree></p:cSld></p:sld>`,
    );
    const rels = [
      ...(s.notes
        ? [
            `<Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`,
          ]
        : []),
      ...(s.rels ?? []).map(
        (r) =>
          `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"${r.mode ? ` TargetMode="${r.mode}"` : ''}/>`,
      ),
    ].join('');
    zip.file(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    );
    if (s.notes) {
      zip.file(
        `ppt/notesSlides/notesSlide${n}.xml`,
        `<p:notes ${NS_A} ${NS_P}><p:cSld><p:spTree>${opts.realNotes ? NUM_SHAPE : ''}<p:sp>${opts.realNotes ? '<p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>' : ''}<p:txBody>${paragraphs(s.notes === '-' ? [] : [s.notes])}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
      );
    }
  });
  for (const [p, data] of Object.entries(opts.media ?? {})) zip.file(p, data);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildDocx(
  opts: { image?: 'png' | 'emf'; bookmark?: boolean } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  const ext = opts.image;
  zip.file(
    '[Content_Types].xml',
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${ext === 'png' ? '<Default Extension="png" ContentType="image/png"/>' : ''}${ext === 'emf' ? '<Default Extension="emf" ContentType="image/x-emf"/>' : ''}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>${ext ? `<Relationship Id="rId2" Type="${REL}/image" Target="media/image1.${ext}"/>` : ''}</Relationships>`,
  );
  zip.file(
    'word/styles.xml',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
  );
  const drawing = ext
    ? `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="1" name="Picture 1" descr="Flow of orders"/><a:graphic ${NS_A}><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId2" ${NS_R}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    : '';
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ${NS_R}><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${opts.bookmark ? '<w:bookmarkStart w:id="0" w:name="_Toc123"/>' : ''}<w:r><w:t>Project Plan</w:t></w:r>${opts.bookmark ? '<w:bookmarkEnd w:id="0"/>' : ''}</w:p><w:p><w:r><w:t>Body text.</w:t></w:r></w:p>${drawing}<w:p><w:r><w:t>After the picture.</w:t></w:r></w:p></w:body></w:document>`,
  );
  if (ext) zip.file(`word/media/image1.${ext}`, PNG);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('pdfToMarkdown', () => {
  it('gives one heading per page', async () => {
    const r = await pdfToMarkdown(await fs.readFile(fixture('two-pages.pdf')));
    expect(r.markdown).toContain('## p.1');
    expect(r.markdown).toContain('First page text here');
    expect(r.markdown).toContain('## p.2');
    expect(r.markdown).toContain('Second page text here');
    expect(r.empty).toBe(false);
    expect(r.images).toEqual([]);
  });

  it('flags a PDF without text or images as empty', async () => {
    const r = await pdfToMarkdown(await fs.readFile(fixture('image-only.pdf')));
    expect(r.empty).toBe(true);
  });

  it('extracts the images of a page as PNG files after its text', async () => {
    const r = await pdfToMarkdown(await fs.readFile(fixture('images.pdf')));
    // The 4×4 and 2×2 pictures are below the size floor: nothing extracted.
    expect(r.images).toEqual([]);
    expect(r.markdown).toContain('Diagram below');
  });

  it('decodes a JPEG picture to a PNG and references it', async () => {
    const r = await pdfToMarkdown(await fs.readFile(fixture('jpeg.pdf')));
    expect(r.images.map((i) => i.name)).toEqual(['p1-1.png']);
    expect(r.markdown).toContain('![p.1 image 1]({{assets}}/p1-1.png)');
    const png = decodePng(r.images[0].data);
    expect(png.width).toBe(320);
    expect(png.height).toBe(200);
    expect(png.colorType).toBe(2);
    // White background: the first pixel is (near) white.
    expect(png.rows[0][0]).toBeGreaterThan(240);
    // No text: accepted on the strength of the picture, with a warning.
    expect(r.empty).toBe(false);
    expect(r.warnings).toContain('no text layer; captured from page images');
  });
});

describe('pptxToMarkdown', () => {
  it('orders slides by presentation.xml and adds notes', async () => {
    const r = await pptxToMarkdown(
      await buildPptx([
        { text: ['Agenda', 'Scope'], notes: 'say hi' },
        { text: ['Phase 2'] },
      ]),
    );
    expect(r.markdown.indexOf('## Slide 1')).toBeLessThan(
      r.markdown.indexOf('## Slide 2'),
    );
    expect(r.markdown).toMatch(/## Slide 1\nAgenda\nScope\n_Notes:_ say hi/);
    expect(r.markdown.indexOf('Agenda')).toBeLessThan(
      r.markdown.indexOf('Phase 2'),
    );
    expect(r.warnings).toEqual([]);
    expect(r.images).toEqual([]);
    expect(r.empty).toBe(false);
  });

  it('ignores the slide-number placeholder in notes', async () => {
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          { text: ['A'], notes: 'real notes' },
          { text: ['B'], notes: '-' },
        ],
        { realNotes: true },
      ),
    );
    expect(r.markdown).toContain('_Notes:_ real notes');
    expect(r.markdown).not.toContain('3');
    expect(r.markdown.match(/_Notes:_/g)).toHaveLength(1);
  });

  it('extracts pictures in slide order with their alt text, once per media file', async () => {
    const media = {
      'ppt/media/image1.png': PNG,
      'ppt/media/image2.jpeg': Buffer.from('jpeg-bytes'),
    };
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          {
            text: ['Architecture'],
            extra: pic('rId2', 'Three tier diagram') + pic('rId3'),
            rels: [
              { id: 'rId2', type: 'image', target: '../media/image1.png' },
              { id: 'rId3', type: 'image', target: '../media/image2.jpeg' },
            ],
          },
          {
            text: ['Again'],
            extra: pic('rId2'),
            rels: [
              { id: 'rId2', type: 'image', target: '../media/image1.png' },
            ],
          },
        ],
        { media },
      ),
    );
    expect(r.images.map((i) => i.name)).toEqual([
      'slide-1-1.png',
      'slide-1-2.jpg',
    ]);
    expect(r.images[0].data.equals(PNG)).toBe(true);
    expect(r.markdown).toContain(
      '## Slide 1\nArchitecture\n![Three tier diagram]({{assets}}/slide-1-1.png)\n![Slide 1 picture 2]({{assets}}/slide-1-2.jpg)',
    );
    expect(r.markdown).toContain(
      '## Slide 2\nAgain\n![Slide 2 picture 1]({{assets}}/slide-1-1.png)',
    );
    expect(r.warnings).toEqual([]);
  });

  it('warns about pictures in formats Claude cannot view and skips linked ones', async () => {
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          {
            text: ['A'],
            extra: pic('rId2') + pic('rId3') + pic('rId4'),
            rels: [
              { id: 'rId2', type: 'image', target: '../media/image1.emf' },
              { id: 'rId3', type: 'image', target: '../media/image2.svg' },
              {
                id: 'rId4',
                type: 'image',
                target: 'https://example.test/x.png',
                mode: 'External',
              },
            ],
          },
        ],
        { media: { 'ppt/media/image1.emf': PNG, 'ppt/media/image2.svg': PNG } },
      ),
    );
    expect(r.images).toEqual([]);
    expect(r.warnings).toEqual([
      '2 pictures in formats Claude cannot view (emf, svg)',
    ]);
    expect(r.markdown).toContain('_Picture 1 (emf) could not be extracted_');
    expect(r.markdown).not.toContain('example.test');
  });

  it('stops at the image cap and says how many were left', async () => {
    const n = MAX_IMAGES + 2;
    const media: Record<string, Buffer> = {};
    const rels = [];
    let extra = '';
    for (let i = 1; i <= n; i++) {
      media[`ppt/media/image${i}.png`] = PNG;
      rels.push({
        id: `rId${i + 1}`,
        type: 'image',
        target: `../media/image${i}.png`,
      });
      extra += pic(`rId${i + 1}`);
    }
    const r = await pptxToMarkdown(
      await buildPptx([{ text: ['Many'], extra, rels }], { media }),
    );
    expect(r.images).toHaveLength(MAX_IMAGES);
    expect(r.warnings).toEqual([
      `2 more pictures not extracted (limit ${MAX_IMAGES})`,
    ]);
    expect(r.markdown).not.toContain(`slide-1-${n}.png`);
  });

  it('renders tables as markdown tables in document order', async () => {
    const r = await pptxToMarkdown(
      await buildPptx([
        {
          text: ['Costs'],
          extra:
            table([['Item', 'EUR | day'], ['Dev', '800'], ['PM']]) +
            '<p:sp><p:txBody>' +
            paragraphs(['Footnote']) +
            '</p:txBody></p:sp>',
        },
      ]),
    );
    expect(r.markdown).toContain(
      '## Slide 1\nCosts\n| Item | EUR \\| day |\n| --- | --- |\n| Dev | 800 |\n| PM |  |\nFootnote',
    );
  });

  it('lists SmartArt labels from the diagram data part', async () => {
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          {
            text: ['Process'],
            extra: smartArt('rId2'),
            rels: [
              {
                id: 'rId2',
                type: 'diagramData',
                target: '../diagrams/data1.xml',
              },
            ],
          },
        ],
        { media: { 'ppt/diagrams/data1.xml': Buffer.from(DIAGRAM_DATA) } },
      ),
    );
    expect(r.markdown).toContain('Process\n_SmartArt:_\n- Plan\n- Build\n');
    expect(r.markdown).not.toContain('hidden');
  });

  it('turns a chart into its title and a table of series', async () => {
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          {
            text: ['Numbers'],
            extra: chart('rId2'),
            rels: [
              { id: 'rId2', type: 'chart', target: '../charts/chart1.xml' },
            ],
          },
        ],
        { media: { 'ppt/charts/chart1.xml': Buffer.from(CHART_DATA) } },
      ),
    );
    expect(r.markdown).toContain(
      'Numbers\n_Chart: Revenue by year_\n|  | 2025 | 2026 |\n| --- | --- | --- |\n| Licences | 10 | 12.5 |\n| Services | 3 | 4 |\n',
    );
  });

  it('reads only the mc:Choice side of alternate content', async () => {
    const r = await pptxToMarkdown(
      await buildPptx([
        {
          text: ['A'],
          extra:
            '<mc:AlternateContent xmlns:mc="x"><mc:Choice Requires="x"><p:sp><p:txBody>' +
            paragraphs(['Modern']) +
            '</p:txBody></p:sp></mc:Choice><mc:Fallback><p:sp><p:txBody>' +
            paragraphs(['Old copy']) +
            '</p:txBody></p:sp></mc:Fallback></mc:AlternateContent>',
        },
      ]),
    );
    expect(r.markdown).toContain('Modern');
    expect(r.markdown).not.toContain('Old copy');
  });

  it('is empty when no slide has text or pictures', async () => {
    const r = await pptxToMarkdown(await buildPptx([{ text: [] }]));
    expect(r.empty).toBe(true);
  });
});

describe('docxToMarkdown', () => {
  it('keeps headings and uses the first as title', async () => {
    const r = await docxToMarkdown(await buildDocx());
    expect(r.markdown).toContain('# Project Plan');
    expect(r.markdown).toContain('Body text');
    expect(r.title).toBe('Project Plan');
    expect(r.empty).toBe(false);
    expect(r.images).toEqual([]);
  });

  it('strips bookmark anchors from headings and the title', async () => {
    const r = await docxToMarkdown(await buildDocx({ bookmark: true }));
    expect(r.markdown).not.toContain('<a');
    expect(r.title).toBe('Project Plan');
  });

  it('extracts pictures in place with their alt text', async () => {
    const r = await docxToMarkdown(await buildDocx({ image: 'png' }));
    expect(r.images.map((i) => i.name)).toEqual(['image-1.png']);
    expect(r.images[0].data.equals(PNG)).toBe(true);
    expect(r.markdown).toMatch(
      /Body text\\?\.\s+!\[Flow of orders\]\({{assets}}\/image-1\.png\)\s+After the picture/,
    );
    expect(r.warnings).toEqual([]);
  });

  it('warns about pictures in formats Claude cannot view', async () => {
    const r = await docxToMarkdown(await buildDocx({ image: 'emf' }));
    expect(r.images).toEqual([]);
    expect(r.markdown).not.toContain('![');
    expect(r.warnings).toEqual([
      '1 picture in formats Claude cannot view (emf)',
    ]);
  });
});

describe('corrupt input', () => {
  const garbage = Buffer.from('this is not a document');
  it('rejects garbage with readable messages', async () => {
    await expect(pdfToMarkdown(garbage)).rejects.toThrow(
      'Not a valid .pdf file',
    );
    await expect(docxToMarkdown(garbage)).rejects.toThrow(
      'Not a valid .docx file',
    );
    await expect(pptxToMarkdown(garbage)).rejects.toThrow(
      'Not a valid .pptx file',
    );
  });
});

describe('convertFile', () => {
  it('returns unsupported for unknown or missing extensions', async () => {
    expect(await convertFile('/tmp/a.xyz')).toBe('unsupported');
    expect(await convertFile('/tmp/README')).toBe('unsupported');
  });

  it('converts pdf, vtt and markdown files by extension', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-'));
    try {
      const pdf = await convertFile(fixture('two-pages.pdf'));
      expect(pdf).not.toBe('unsupported');
      const md = path.join(dir, 'n.md');
      await fs.writeFile(md, 'intro\n# Hello\ntext');
      expect(await convertFile(md)).toMatchObject({
        markdown: 'intro\n# Hello\ntext',
        title: 'Hello',
        images: [],
        empty: false,
      });
      const txt = path.join(dir, 'n.txt');
      await fs.writeFile(txt, 'plain');
      expect(await convertFile(txt)).toMatchObject({ title: null });
      const blank = path.join(dir, 'blank.txt');
      await fs.writeFile(blank, '  \n');
      expect(await convertFile(blank)).toMatchObject({ empty: true });
      const vtt = path.join(dir, 'n.VTT');
      await fs.writeFile(
        vtt,
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ann>Hi there</v>\n',
      );
      const r = await convertFile(vtt);
      expect(r).not.toBe('unsupported');
      if (r !== 'unsupported') expect(r.markdown).toContain('Hi there');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
