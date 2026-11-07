import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from './index';
import { docxToMarkdown } from './docx';
import { vi } from 'vitest';
import { MAX_PAGE_RENDERS, pdfToMarkdown } from './pdf';
import * as raster from './raster';
import { decodePng } from './png';
import { pptxToMarkdown } from './pptx';
import {
  ImageCollector,
  MAX_IMAGES,
  pictureWhere,
  type Rasterize,
} from './types';

/** A rasterize hook that turns anything but "bad" into a tiny PNG and records what it saw. */
const fakeRasterize = (): Rasterize & { seen: string[] } => {
  const seen: string[] = [];
  const hook = (async (data: Buffer, ext: string) => {
    seen.push(ext);
    return ext === 'bad' ? null : Buffer.concat([PNG, data]);
  }) as Rasterize & { seen: string[] };
  hook.seen = seen;
  return hook;
};

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
  opts: {
    image?: 'png' | 'emf';
    /** Several pictures, in document order; `image` is one. */
    images?: ('png' | 'emf')[];
    bookmark?: boolean;
  } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  const exts = opts.images ?? (opts.image ? [opts.image] : []);
  zip.file(
    '[Content_Types].xml',
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.includes('png') ? '<Default Extension="png" ContentType="image/png"/>' : ''}${exts.includes('emf') ? '<Default Extension="emf" ContentType="image/x-emf"/>' : ''}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>${exts
      .map(
        (ext, i) =>
          `<Relationship Id="rId${i + 2}" Type="${REL}/image" Target="media/image${i + 1}.${ext}"/>`,
      )
      .join('')}</Relationships>`,
  );
  zip.file(
    'word/styles.xml',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
  );
  const drawing = exts
    .map(
      (_, i) =>
        `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="${i + 1}" name="Picture ${i + 1}" descr="Flow of orders"/><a:graphic ${NS_A}><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId${i + 2}" ${NS_R}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
    )
    .join('');
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ${NS_R}><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${opts.bookmark ? '<w:bookmarkStart w:id="0" w:name="_Toc123"/>' : ''}<w:r><w:t>Project Plan</w:t></w:r>${opts.bookmark ? '<w:bookmarkEnd w:id="0"/>' : ''}</w:p><w:p><w:r><w:t>Body text.</w:t></w:r></w:p>${drawing}<w:p><w:r><w:t>After the picture.</w:t></w:r></w:p></w:body></w:document>`,
  );
  exts.forEach((ext, i) => zip.file(`word/media/image${i + 1}.${ext}`, PNG));
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

  it('counts pictures below the size floor as tiny, not as dropped', async () => {
    const r = await pdfToMarkdown(await fs.readFile(fixture('images.pdf')));
    expect(r.tiny).toBe(2);
    expect(r.dropped).toEqual([]);
  });

  it('waits for pdf.js to decode a picture and stores one painted on several pages once', async () => {
    const r = await pdfToMarkdown(
      await fs.readFile(fixture('repeated-image.pdf')),
    );
    expect(r.images.map((i) => i.name)).toEqual(['p1-1.png']);
    const png = decodePng(r.images[0].data);
    expect([png.width, png.height]).toEqual([100, 100]);
    expect(r.markdown).toContain(
      '## p.1\n\n![p.1 image 1]({{assets}}/p1-1.png)',
    );
    expect(r.markdown).toContain('## p.2\n\n![p.2 image]({{assets}}/p1-1.png)');
    expect(r.markdown).toContain('## p.4\n\n![p.4 image]({{assets}}/p1-1.png)');
    expect(r.empty).toBe(false);
  });

  it('renders a page that carries a drawing, not a page with a rule', async () => {
    const r = await pdfToMarkdown(await fs.readFile(fixture('drawing.pdf')));
    expect(r.images.map((i) => i.name)).toEqual(['p1.png']);
    const png = decodePng(r.images[0].data);
    expect(Math.max(png.width, png.height)).toBe(1600);
    expect(r.markdown).toContain('## p.1\n\nTarget architecture\n');
    expect(r.markdown).toContain('![p.1 as drawn]({{assets}}/p1.png)');
    expect(r.markdown).toContain(
      '## p.2\n\nPlain page with one rule below the title\n',
    );
    expect(r.markdown).not.toContain('p2.png');
    expect(r.warnings).toEqual([]);
  });

  it('tells a drawing from rules, backgrounds, clips and tiny or scaled paths', async () => {
    const r = await pdfToMarkdown(
      await fs.readFile(fixture('drawing-edges.pdf')),
    );
    // p.1: a white page background, a page clip and seven rules; p.2: eight boxes under a 10× transform;
    // p.3: eight bars under a 0.1× transform.
    expect(r.images.map((i) => i.name)).toEqual(['p2.png']);
    expect(r.markdown).toContain('## p.1\n\nText page with rules\n\n## p.2');
    expect(r.markdown).toContain(
      'Scaled diagram\n![p.2 as drawn]({{assets}}/p2.png)',
    );
    expect(r.markdown).toContain('## p.3\n\nTiny bars\n');
  });

  it('measures rotated pages in their own space', async () => {
    const r = await pdfToMarkdown(await fs.readFile(fixture('rotated.pdf')));
    // Both pages are /Rotate 90: a background with rules is still no drawing; nine boxes still are.
    expect(r.images.map((i) => i.name)).toEqual(['p2.png']);
    const png = decodePng(r.images[0].data);
    // Rendered as shown: landscape.
    expect(png.width).toBeGreaterThan(png.height);
  });

  it('keeps the text and warns when a page cannot be rendered', async () => {
    const spy = vi.spyOn(raster, 'loadCanvas').mockResolvedValue({
      createCanvas: () => {
        throw new Error('no skia');
      },
    } as unknown as Awaited<ReturnType<typeof raster.loadCanvas>>);
    try {
      const r = await pdfToMarkdown(await fs.readFile(fixture('drawing.pdf')));
      expect(r.images).toEqual([]);
      expect(r.markdown).toContain('Target architecture');
      expect(r.warnings).toEqual([
        'p.1: the drawing could not be rendered (no skia)',
      ]);
      expect(r.dropped).toEqual([
        {
          where: 'Page 1 (drawing)',
          reason: 'the drawing could not be rendered',
          fix: 'Export the page as an image and add it as its own source',
        },
      ]);
      expect(r.empty).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('renders at most the first pages with drawings and says how many were left', async () => {
    const r = await pdfToMarkdown(
      await fs.readFile(fixture('many-drawings.pdf')),
    );
    expect(r.images).toHaveLength(MAX_PAGE_RENDERS);
    expect(r.images[0].name).toBe('p1.png');
    expect(r.images[MAX_PAGE_RENDERS - 1].name).toBe(
      `p${MAX_PAGE_RENDERS}.png`,
    );
    expect(r.warnings).toEqual([
      `2 more pages with drawings not rendered (limit ${MAX_PAGE_RENDERS})`,
    ]);
  });

  it('reports each page with a drawing past the render limit', async () => {
    const r = await pdfToMarkdown(
      await fs.readFile(fixture('many-drawings.pdf')),
    );
    const fix = 'Split the PDF so each part has at most 20 drawn pages';
    expect(r.dropped).toEqual([
      {
        where: 'Page 21 (drawing)',
        reason: 'past the 20-page render limit',
        fix,
      },
      {
        where: 'Page 22 (drawing)',
        reason: 'past the 20-page render limit',
        fix,
      },
    ]);
  });

  it('reports the drawn pages when the canvas is missing', async () => {
    const spy = vi.spyOn(raster, 'loadCanvas').mockResolvedValue(null);
    try {
      const r = await pdfToMarkdown(await fs.readFile(fixture('drawing.pdf')));
      expect(r.warnings).toEqual([
        'pages with drawings were not rendered: canvas unavailable',
      ]);
      expect(r.dropped).toEqual([
        {
          where: 'Page 1 (drawing)',
          reason: 'the drawing could not be rendered',
          fix: 'Export the page as an image and add it as its own source',
        },
      ]);
    } finally {
      spy.mockRestore();
    }
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

  it('reports each picture it could not convert, with where it was', async () => {
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          { text: ['A'] },
          {
            text: ['B'],
            extra: pic('rId2') + pic('rId3') + pic('rId2'),
            rels: [
              { id: 'rId2', type: 'image', target: '../media/image1.emf' },
              { id: 'rId3', type: 'image', target: '../media/image2.svg' },
            ],
          },
        ],
        { media: { 'ppt/media/image1.emf': PNG, 'ppt/media/image2.svg': PNG } },
      ),
    );
    // The EMF is used twice but is one picture: one drop.
    expect(r.dropped).toEqual([
      {
        where: 'Slide 2, picture 1',
        reason: 'EMF converts on Windows only',
        fix: 'Remove the source and add it again on Windows, or save the picture as PNG in the file',
      },
      {
        where: 'Slide 2, picture 2',
        reason: 'SVG could not be converted',
        fix: 'Save the picture as PNG in the file, then remove the source and add it again',
      },
    ]);
    expect(r.dropped[0].fix).toContain('Remove the source and add it again');
  });

  it('converts pictures in other formats through the rasterize hook', async () => {
    const rasterize = fakeRasterize();
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          {
            text: ['A'],
            extra: pic('rId2', 'Visio flow') + pic('rId3'),
            rels: [
              { id: 'rId2', type: 'image', target: '../media/image1.emf' },
              { id: 'rId3', type: 'image', target: '../media/image2.bad' },
            ],
          },
        ],
        {
          media: {
            'ppt/media/image1.emf': Buffer.from('emf'),
            'ppt/media/image2.bad': Buffer.from('x'),
          },
        },
      ),
      { rasterize },
    );
    expect(rasterize.seen).toEqual(['emf', 'bad']);
    expect(r.images.map((i) => i.name)).toEqual(['slide-1-1.png']);
    expect(r.images[0].data.subarray(PNG.length).toString()).toBe('emf');
    expect(r.markdown).toContain('![Visio flow]({{assets}}/slide-1-1.png)');
    expect(r.markdown).toContain('_Picture 2 (bad) could not be extracted_');
    expect(r.warnings).toEqual([
      '1 picture in formats Claude cannot view (bad)',
    ]);
  });

  it('marks every reference to a picture that could not be extracted', async () => {
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          {
            text: ['A'],
            extra: pic('rId2') + pic('rId3') + pic('rId2') + pic('rId4'),
            rels: [
              { id: 'rId2', type: 'image', target: '../media/image1.emf' },
              { id: 'rId3', type: 'image', target: '../media/image2.png' },
              { id: 'rId4', type: 'image', target: '../media/missing.png' },
            ],
          },
        ],
        {
          media: {
            'ppt/media/image1.emf': Buffer.from('emf'),
            'ppt/media/image2.png': PNG,
          },
        },
      ),
    );
    expect(r.markdown).toContain(
      '_Picture 1 (emf) could not be extracted_\n![Slide 1 picture 2]({{assets}}/slide-1-2.png)\n_Picture 3 (emf) could not be extracted_\n',
    );
    // A missing media file is not a format problem: no marker.
    expect(r.markdown).not.toContain('Picture 4');
    expect(r.warnings).toEqual([
      '1 picture in formats Claude cannot view (emf)',
    ]);
  });

  it('takes a picture used as a shape fill', async () => {
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          {
            text: ['A'],
            extra:
              '<p:sp><p:nvSpPr><p:cNvPr id="9" name="Box" descr="Filled box"/></p:nvSpPr><p:spPr><a:blipFill><a:blip r:embed="rId2"/></a:blipFill></p:spPr><p:txBody>' +
              paragraphs(['Label']) +
              '</p:txBody></p:sp>',
            rels: [
              { id: 'rId2', type: 'image', target: '../media/image1.png' },
            ],
          },
        ],
        { media: { 'ppt/media/image1.png': PNG } },
      ),
    );
    expect(r.markdown).toContain(
      'A\nLabel\n![Filled box]({{assets}}/slide-1-1.png)',
    );
  });

  it('lists the pictures of the slide layouts and master once, at the end', async () => {
    const layoutRel = (n: number) => ({
      id: 'rId7',
      type: 'slideLayout',
      target: `../slideLayouts/slideLayout${n}.xml`,
    });
    const media: Record<string, Buffer> = {
      'ppt/media/logo.png': PNG,
      'ppt/media/bg.png': Buffer.from('bg'),
      'ppt/slideLayouts/slideLayout1.xml': Buffer.from(
        `<p:sldLayout ${NS_A} ${NS_P} ${NS_R}><p:cSld><p:spTree>${pic('rId2', 'Company logo')}</p:spTree></p:cSld></p:sldLayout>`,
      ),
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels': Buffer.from(
        `<Relationships><Relationship Id="rId2" Type="${REL}/image" Target="../media/logo.png"/><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
      ),
      'ppt/slideLayouts/slideLayout2.xml': Buffer.from(
        `<p:sldLayout ${NS_A} ${NS_P} ${NS_R}><p:cSld><p:spTree>${pic('rId2')}</p:spTree></p:cSld></p:sldLayout>`,
      ),
      'ppt/slideLayouts/_rels/slideLayout2.xml.rels': Buffer.from(
        `<Relationships><Relationship Id="rId2" Type="${REL}/image" Target="../media/logo.png"/><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
      ),
      'ppt/slideMasters/slideMaster1.xml': Buffer.from(
        `<p:sldMaster ${NS_A} ${NS_P} ${NS_R}><p:cSld><p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId3"/></a:blipFill></p:bgPr></p:bg><p:spTree></p:spTree></p:cSld></p:sldMaster>`,
      ),
      'ppt/slideMasters/_rels/slideMaster1.xml.rels': Buffer.from(
        `<Relationships><Relationship Id="rId3" Type="${REL}/image" Target="../media/bg.png"/></Relationships>`,
      ),
    };
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          { text: ['One'], rels: [layoutRel(1)] },
          { text: ['Two'], rels: [layoutRel(2)] },
          { text: ['Three'], rels: [layoutRel(1)] },
        ],
        { media },
      ),
    );
    expect(r.images.map((i) => i.name)).toEqual([
      'layout-1.png',
      'layout-2.png',
    ]);
    expect(
      r.markdown.endsWith(
        '## Slide 3\nThree\n\n## Slide layouts and master\nPictures that appear on the slide layouts and master (logos, backgrounds), once each.\n![Company logo]({{assets}}/layout-1.png)\n![Layout picture 2]({{assets}}/layout-2.png)\n',
      ),
    ).toBe(true);
  });

  it('resolves alternate content nested inside alternate content', async () => {
    const inner =
      '<mc:AlternateContent xmlns:mc="x"><mc:Choice Requires="y"><p:sp><p:txBody>' +
      paragraphs(['Inner new']) +
      '</p:txBody></p:sp></mc:Choice><mc:Fallback><p:sp><p:txBody>' +
      paragraphs(['Inner old']) +
      '</p:txBody></p:sp></mc:Fallback></mc:AlternateContent>';
    const r = await pptxToMarkdown(
      await buildPptx([
        {
          text: ['A'],
          extra:
            '<mc:AlternateContent xmlns:mc="x"><mc:Choice Requires="x"><p:sp><p:txBody>' +
            paragraphs(['Outer new']) +
            '</p:txBody></p:sp>' +
            inner +
            '</mc:Choice><mc:Fallback><p:sp><p:txBody>' +
            paragraphs(['Outer old']) +
            '</p:txBody></p:sp></mc:Fallback></mc:AlternateContent>',
        },
      ]),
    );
    expect(r.markdown).toContain('A\nOuter new\nInner new\n');
    expect(r.markdown).not.toContain('old');
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

  it('reports each picture past the image cap', async () => {
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
    const fix =
      'Split the file, or remove pictures that carry nothing, then remove the source and add it again';
    expect(r.dropped).toEqual([
      {
        where: 'Slide 1, picture 61',
        reason: 'over the 60-picture limit',
        fix,
      },
      {
        where: 'Slide 1, picture 62',
        reason: 'over the 60-picture limit',
        fix,
      },
    ]);
  });

  it('reports a layout picture it could not convert, numbered among the layout pictures', async () => {
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          {
            text: ['One'],
            rels: [
              {
                id: 'rId7',
                type: 'slideLayout',
                target: '../slideLayouts/slideLayout1.xml',
              },
            ],
          },
        ],
        {
          media: {
            'ppt/media/logo.png': PNG,
            'ppt/media/mark.wmf': PNG,
            'ppt/slideLayouts/slideLayout1.xml': Buffer.from(
              `<p:sldLayout ${NS_A} ${NS_P} ${NS_R}><p:cSld><p:spTree>${pic('rId2')}${pic('rId3')}</p:spTree></p:cSld></p:sldLayout>`,
            ),
            'ppt/slideLayouts/_rels/slideLayout1.xml.rels': Buffer.from(
              `<Relationships><Relationship Id="rId2" Type="${REL}/image" Target="../media/logo.png"/><Relationship Id="rId3" Type="${REL}/image" Target="../media/mark.wmf"/></Relationships>`,
            ),
          },
        },
      ),
    );
    expect(r.images.map((i) => i.name)).toEqual(['layout-1.png']);
    expect(r.dropped).toEqual([
      {
        where: 'Slide layouts and master, picture 2',
        reason: 'WMF converts on Windows only',
        fix: 'Remove the source and add it again on Windows, or save the picture as PNG in the file',
      },
    ]);
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

  it("keeps an embedded object's preview picture from the mc:Fallback side", async () => {
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          {
            text: ['Visio'],
            extra:
              '<p:graphicFrame><a:graphic><a:graphicData><mc:AlternateContent xmlns:mc="x"><mc:Choice Requires="v"><p:oleObj name="Visio" r:id="rId9"><p:embed/></p:oleObj></mc:Choice><mc:Fallback><p:oleObj name="Visio" r:id="rId9">' +
              pic('rId2', 'Process map') +
              '</p:oleObj></mc:Fallback></mc:AlternateContent></a:graphicData></a:graphic></p:graphicFrame>',
            rels: [
              { id: 'rId2', type: 'image', target: '../media/image1.png' },
            ],
          },
        ],
        { media: { 'ppt/media/image1.png': PNG } },
      ),
    );
    expect(r.images.map((i) => i.name)).toEqual(['slide-1-1.png']);
    expect(r.markdown).toContain('![Process map]({{assets}}/slide-1-1.png)');
  });

  it('does not mistake an axis title for the chart title', async () => {
    const data = CHART_DATA.replace(
      /<c:title>[\s\S]*?<\/c:title>/,
      '<c:autoTitleDeleted val="1"/>',
    ).replace(
      '</c:barChart>',
      `</c:barChart><c:valAx><c:title><c:tx><c:rich>${paragraphs(['EUR (thousands)'])}</c:rich></c:tx></c:title></c:valAx>`,
    );
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
        { media: { 'ppt/charts/chart1.xml': Buffer.from(data) } },
      ),
    );
    expect(r.markdown).toContain('Numbers\n_Chart_\n|  | 2025 | 2026 |');
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

  it('converts an EMF picture through the rasterize hook', async () => {
    const rasterize = fakeRasterize();
    const r = await docxToMarkdown(await buildDocx({ image: 'emf' }), {
      rasterize,
    });
    expect(rasterize.seen).toEqual(['emf']);
    expect(r.images.map((i) => i.name)).toEqual(['image-1.png']);
    expect(r.markdown).toContain('![Flow of orders]({{assets}}/image-1.png)');
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

  it('reports a picture it could not convert', async () => {
    const r = await docxToMarkdown(await buildDocx({ image: 'emf' }));
    expect(r.dropped).toEqual([
      {
        where: 'Picture 1',
        reason: 'EMF converts on Windows only',
        fix: 'Remove the source and add it again on Windows, or save the picture as PNG in the file',
      },
    ]);
    expect(r.tiny).toBe(0);
  });

  it('numbers pictures by their place in the document, taken or not', async () => {
    const r = await docxToMarkdown(
      await buildDocx({ images: ['emf', 'emf', 'png'] }),
    );
    expect(r.dropped.map((d) => d.where)).toEqual(['Picture 1', 'Picture 2']);
    expect(r.images.map((i) => i.name)).toEqual(['image-3.png']);
    expect(r.markdown).toContain('![Flow of orders]({{assets}}/image-3.png)');
  });
});

describe('ImageCollector', () => {
  it('names where a picture was from the name its converter gave it', () => {
    expect(pictureWhere('slide-9-2')).toBe('Slide 9, picture 2');
    expect(pictureWhere('p3.png')).toBe('Page 3');
    expect(pictureWhere('p3-2.png')).toBe('Page 3, picture 2');
    expect(pictureWhere('sheet-2-4')).toBe('Sheet 2, picture 4');
    expect(pictureWhere('image-5')).toBe('Picture 5');
    expect(pictureWhere('layout-1')).toBe('Slide layouts and master');
  });

  it('reports a picture in a format without a name', async () => {
    const images = new ImageCollector();
    expect(await images.addAny('image-1', PNG, '')).toBeNull();
    expect(images.dropped).toEqual([
      {
        where: 'Picture 1',
        reason: 'UNKNOWN could not be converted',
        fix: 'Save the picture as PNG in the file, then remove the source and add it again',
      },
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
