import fs from 'node:fs/promises';
import path from 'node:path';
import { docxToMarkdown } from './docx';
import { drawioToMarkdown } from './drawio';
import { pdfToMarkdown } from './pdf';
import { pptxToMarkdown } from './pptx';
import { firstHeading, type Converted } from './types';
import { vttToMarkdown } from './vtt';

export type { Converted, ConvertedImage } from './types';
export { ASSETS_PLACEHOLDER } from './types';
export { docxToMarkdown, pdfToMarkdown, pptxToMarkdown };

function plain(markdown: string): Converted {
  return {
    markdown,
    title: firstHeading(markdown),
    images: [],
    warnings: [],
    empty: markdown.trim() === '',
  };
}

export async function convertFile(
  absPath: string,
): Promise<Converted | 'unsupported'> {
  switch (path.extname(absPath).toLowerCase()) {
    case '.pdf':
      return pdfToMarkdown(await fs.readFile(absPath));
    case '.docx':
      return docxToMarkdown(await fs.readFile(absPath));
    case '.pptx':
      return pptxToMarkdown(await fs.readFile(absPath));
    case '.drawio':
      return drawioToMarkdown(await fs.readFile(absPath, 'utf8'));
    case '.vtt':
      return plain(vttToMarkdown(await fs.readFile(absPath, 'utf8')));
    case '.md':
    case '.txt':
      return plain(await fs.readFile(absPath, 'utf8'));
    default:
      return 'unsupported';
  }
}
