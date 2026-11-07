import mammoth from 'mammoth';
import {
  ImageCollector,
  firstHeading,
  imageExt,
  type ConvertOptions,
  type Converted,
} from './types';

// The shipped typings omit convertToMarkdown, though the function exists.
const toMarkdown = (
  mammoth as unknown as {
    convertToMarkdown: typeof mammoth.convertToHtml;
  }
).convertToMarkdown;

export async function docxToMarkdown(
  buf: Buffer,
  opts: ConvertOptions = {},
): Promise<Converted> {
  const images = new ImageCollector(opts.rasterize);
  // mammoth escapes markdown punctuation in the src it writes, so it gets a bare token per picture.
  const refs: string[] = [];
  let result: Awaited<ReturnType<typeof toMarkdown>>;
  try {
    result = await toMarkdown(
      { buffer: buf },
      {
        // Each picture goes to the assets folder; the markdown keeps an image link in place.
        convertImage: mammoth.images.imgElement(async (image) => {
          const ref = await images.addAny(
            `image-${refs.length + 1}`,
            Buffer.from(await image.readAsBuffer()),
            imageExt(image.contentType ?? ''),
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
    dropped: images.dropped,
    tiny: images.tiny,
    empty: markdown.trim() === '' && images.images.length === 0,
  };
}
