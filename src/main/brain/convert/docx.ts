import JSZip from 'jszip';
import mammoth from 'mammoth';
import { firstHeading, type Converted } from './types';

// The shipped typings omit convertToMarkdown, though the function exists.
const toMarkdown = (
  mammoth as unknown as {
    convertToMarkdown: typeof mammoth.convertToHtml;
  }
).convertToMarkdown;

export async function docxToMarkdown(buf: Buffer): Promise<Converted> {
  const result = await toMarkdown(
    { buffer: buf },
    // Images are dropped; embedding base64 data would bloat the brain.
    { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
  );
  // mammoth escapes markdown punctuation; keep its output but drop empty image tags.
  const markdown = result.value.replace(/!\[[^\]]*\]\(\)/g, '').trim() + '\n';
  const zip = await JSZip.loadAsync(buf);
  const hasImages = Object.keys(zip.files).some((f) =>
    f.startsWith('word/media/'),
  );
  return {
    markdown,
    title: firstHeading(markdown),
    needsOcr: false,
    warnings: hasImages ? ['images dropped'] : [],
  };
}
