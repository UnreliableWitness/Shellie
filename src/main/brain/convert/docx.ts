import mammoth from 'mammoth';
import {
  ImageCollector,
  VIEWABLE,
  firstHeading,
  imageExt,
  type Converted,
} from './types';

// The shipped typings omit convertToMarkdown, though the function exists.
const toMarkdown = (
  mammoth as unknown as {
    convertToMarkdown: typeof mammoth.convertToHtml;
  }
).convertToMarkdown;

export async function docxToMarkdown(buf: Buffer): Promise<Converted> {
  const images = new ImageCollector();
  // mammoth escapes markdown punctuation in the src it writes, so it gets a bare token per picture.
  const refs: string[] = [];
  let result: Awaited<ReturnType<typeof toMarkdown>>;
  try {
    result = await toMarkdown(
      { buffer: buf },
      {
        // Each picture goes to the assets folder; the markdown keeps an image link in place.
        convertImage: mammoth.images.imgElement(async (image) => {
          const ext = imageExt(image.contentType ?? '');
          if (!VIEWABLE.has(ext)) {
            images.skip(ext);
            return { src: '' };
          }
          const ref = images.add(
            `image-${refs.length + 1}.${ext}`,
            Buffer.from(await image.readAsBuffer()),
          );
          if (!ref) return { src: '' };
          refs.push(ref);
          return { src: `brainimage${refs.length}` };
        }),
      },
    );
  } catch (err) {
    throw new Error('Not a valid .docx file', { cause: err });
  }
  // mammoth escapes markdown punctuation; keep its output but drop empty image tags.
  // Bookmark anchors (`<a id="_Toc…"></a>`) are useless here and pollute titles.
  const markdown =
    result.value
      .replace(/\]\(brainimage(\d+)\)/g, (_, n) => `](${refs[Number(n) - 1]})`)
      .replace(/!\[[^\]]*\]\(\)/g, '')
      .replace(/<a id="[^"]*"><\/a>/g, '')
      .trim() + '\n';
  return {
    markdown,
    title: firstHeading(markdown),
    images: images.images,
    warnings: images.warnings(),
    empty: markdown.trim() === '' && images.images.length === 0,
  };
}
