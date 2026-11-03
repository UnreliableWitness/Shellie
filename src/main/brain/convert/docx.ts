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
  let result: Awaited<ReturnType<typeof toMarkdown>>;
  let zip: JSZip;
  try {
    result = await toMarkdown(
      { buffer: buf },
      // Images are dropped; embedding base64 data would bloat the brain.
      { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
    );
    zip = await JSZip.loadAsync(buf);
  } catch (err) {
    throw new Error('Not a valid .docx file', { cause: err });
  }
  // mammoth escapes markdown punctuation; keep its output but drop empty image tags.
  // Bookmark anchors (`<a id="_Toc…"></a>`) are useless here and pollute titles.
  const markdown =
    result.value
      .replace(/!\[[^\]]*\]\(\)/g, '')
      .replace(/<a id="[^"]*"><\/a>/g, '')
      .trim() + '\n';
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
