import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertFile } from './index';
import { docxToMarkdown } from './docx';
import { pdfToMarkdown } from './pdf';
import { pptxToMarkdown } from './pptx';

const fixture = (name: string) => path.join(__dirname, '__fixtures__', name);

type SlideSpec = { text: string[]; notes?: string };

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

async function buildPptx(
  slides: SlideSpec[],
  withImage = false,
  realNotes = false,
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
      `<p:sld ${NS_A} ${NS_P}><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs(s.text)}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
    const rels = s.notes
      ? `<Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`
      : '';
    zip.file(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    );
    if (s.notes) {
      zip.file(
        `ppt/notesSlides/notesSlide${n}.xml`,
        `<p:notes ${NS_A} ${NS_P}><p:cSld><p:spTree>${realNotes ? NUM_SHAPE : ''}<p:sp>${realNotes ? '<p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>' : ''}<p:txBody>${paragraphs(s.notes === '-' ? [] : [s.notes])}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
      );
    }
  });
  if (withImage) zip.file('ppt/media/image1.png', Buffer.from([1, 2, 3]));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildDocx(withImage = false, bookmark = false): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    'word/styles.xml',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
  );
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${bookmark ? '<w:bookmarkStart w:id="0" w:name="_Toc123"/>' : ''}<w:r><w:t>Project Plan</w:t></w:r>${bookmark ? '<w:bookmarkEnd w:id="0"/>' : ''}</w:p><w:p><w:r><w:t>Body text.</w:t></w:r></w:p></w:body></w:document>`,
  );
  if (withImage) zip.file('word/media/image1.png', Buffer.from([1, 2, 3]));
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('pdfToMarkdown', () => {
  it('gives one heading per page', async () => {
    const r = await pdfToMarkdown(await fs.readFile(fixture('two-pages.pdf')));
    expect(r.markdown).toContain('## p.1');
    expect(r.markdown).toContain('First page text here');
    expect(r.markdown).toContain('## p.2');
    expect(r.markdown).toContain('Second page text here');
    expect(r.needsOcr).toBe(false);
  });

  it('flags a PDF without text as needing OCR', async () => {
    const r = await pdfToMarkdown(await fs.readFile(fixture('image-only.pdf')));
    expect(r.needsOcr).toBe(true);
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
  });

  it('ignores the slide-number placeholder in notes', async () => {
    const r = await pptxToMarkdown(
      await buildPptx(
        [
          { text: ['A'], notes: 'real notes' },
          { text: ['B'], notes: '-' },
        ],
        false,
        true,
      ),
    );
    expect(r.markdown).toContain('_Notes:_ real notes');
    expect(r.markdown).not.toContain('3');
    expect(r.markdown.match(/_Notes:_/g)).toHaveLength(1);
  });

  it('warns when images are dropped', async () => {
    const r = await pptxToMarkdown(await buildPptx([{ text: ['A'] }], true));
    expect(r.warnings).toContain('images dropped');
  });
});

describe('docxToMarkdown', () => {
  it('keeps headings and uses the first as title', async () => {
    const r = await docxToMarkdown(await buildDocx());
    expect(r.markdown).toContain('# Project Plan');
    expect(r.markdown).toContain('Body text');
    expect(r.title).toBe('Project Plan');
    expect(r.needsOcr).toBe(false);
  });

  it('strips bookmark anchors from headings and the title', async () => {
    const r = await docxToMarkdown(await buildDocx(false, true));
    expect(r.markdown).not.toContain('<a');
    expect(r.title).toBe('Project Plan');
  });

  it('warns when images are dropped', async () => {
    const r = await docxToMarkdown(await buildDocx(true));
    expect(r.warnings).toContain('images dropped');
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
      });
      const txt = path.join(dir, 'n.txt');
      await fs.writeFile(txt, 'plain');
      expect(await convertFile(txt)).toMatchObject({ title: null });
      const vtt = path.join(dir, 'n.VTT');
      await fs.writeFile(
        vtt,
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ann>Hi there</v>\n',
      );
      const r = await convertFile(vtt);
      expect(r).not.toBe('unsupported');
      if (r !== 'unsupported') expect(r.markdown).toContain('Hi there');
      const drawio = path.join(dir, 'n.drawio');
      await fs.writeFile(
        drawio,
        '<mxfile><diagram name="Flow"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="Start" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>',
      );
      const d = await convertFile(drawio);
      expect(d).not.toBe('unsupported');
      if (d !== 'unsupported') expect(d.markdown).toContain('n1["Start"]');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
