import fs from 'node:fs/promises';
import path from 'node:path';
import { docxToMarkdown } from './docx';
import { drawioToMarkdown } from './drawio';
import { pdfToMarkdown } from './pdf';
import { pptxToMarkdown } from './pptx';
import { firstHeading, type ConvertOptions, type Converted } from './types';
import { vttToMarkdown } from './vtt';
import { xlsxToMarkdown } from './xlsx';
import { xmlToMarkdown } from './xml';

export type {
  ConvertOptions,
  Converted,
  ConvertedImage,
  Rasterize,
} from './types';
export { ASSETS_PLACEHOLDER } from './types';
export { docxToMarkdown, pdfToMarkdown, pptxToMarkdown, xlsxToMarkdown };
export { describeContents } from './describe';

function plain(markdown: string): Converted {
  return {
    markdown,
    title: firstHeading(markdown),
    images: [],
    warnings: [],
    dropped: [],
    tiny: 0,
    empty: markdown.trim() === '',
  };
}

export async function convertFile(
  absPath: string,
  opts: ConvertOptions = {},
): Promise<Converted | 'unsupported'> {
  switch (path.extname(absPath).toLowerCase()) {
    case '.pdf':
      return pdfToMarkdown(await fs.readFile(absPath), opts);
    case '.docx':
      return docxToMarkdown(await fs.readFile(absPath), opts);
    case '.pptx':
      return pptxToMarkdown(await fs.readFile(absPath), opts);
    case '.xlsx':
      return xlsxToMarkdown(await fs.readFile(absPath), opts);
    case '.drawio':
      return drawioToMarkdown(await fs.readFile(absPath, 'utf8'));
    case '.vtt':
      return plain(vttToMarkdown(await fs.readFile(absPath, 'utf8')));
    case '.xml':
      return plain(xmlToMarkdown(await fs.readFile(absPath, 'utf8')));
    case '.md':
    case '.txt':
      return plain(await fs.readFile(absPath, 'utf8'));
    default:
      return 'unsupported';
  }
}
