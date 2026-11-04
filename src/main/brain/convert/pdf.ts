import { encodePng, type PixelKind } from './png';
import { ImageCollector, type Converted } from './types';

const TEXT_THRESHOLD = 20;
/** Bullets, rules and icons: not worth a look. */
const MIN_IMAGE_SIDE = 48;
const MAX_PIXELS = 25_000_000;

/** pdf.js ImageKind values. */
const KIND: Record<number, PixelKind> = { 1: 'gray1', 2: 'rgb', 3: 'rgba' };

type PdfImage = {
  width: number;
  height: number;
  kind: number;
  data?: Uint8Array | Uint8ClampedArray;
  /** The PDF object reference, shared by every page that paints the same image. */
  ref?: string | null;
};

/** How long to wait for pdf.js to decode one image. */
const IMAGE_WAIT_MS = 10_000;

type Page = Awaited<
  ReturnType<
    Awaited<
      ReturnType<
        (typeof import('pdfjs-dist/legacy/build/pdf.mjs'))['getDocument']
      >['promise']
    >['getPage']
  >
>;

/**
 * Reads a painted image's pixels once pdf.js has decoded them (the operator list comes back before the
 * image data does); null for masks, failed decodes and images that take too long.
 */
async function imageOf(page: Page, arg: unknown): Promise<PdfImage | null> {
  let obj: unknown;
  if (typeof arg === 'string') {
    const store = arg.startsWith('g_') ? page.commonObjs : page.objs;
    obj = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => resolve(null), IMAGE_WAIT_MS);
      try {
        store.get(
          arg,
          (data: unknown) => {
            clearTimeout(timer);
            resolve(data);
          },
          () => {
            clearTimeout(timer);
            resolve(null);
          },
        );
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
  } else obj = arg;
  const img = obj as PdfImage | null;
  return img && img.data && img.width > 0 && img.height > 0 ? img : null;
}

export async function pdfToMarkdown(buf: Uint8Array): Promise<Converted> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Once bundled there is no pdf.worker.mjs file next to the main bundle for the
  // in-process "fake worker" to load, so hand pdf.js the worker module directly.
  const g = globalThis as { pdfjsWorker?: unknown };
  g.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  // Copy: pdf.js takes ownership of (detaches) the buffer it is given.
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    useSystemFonts: true,
    // Pixels, not bitmaps, for JPEG images.
    isOffscreenCanvasSupported: false,
  });
  const paintOps = new Set([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
  ]);
  try {
    const doc = await task.promise;
    const sections: string[] = [];
    const images = new ImageCollector();
    // Object reference (or name) -> markdown path, so an image painted on several pages is stored once.
    const seen = new Map<string, string | null>();
    let total = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        text += item.hasEOL ? '\n' : ' ';
      }
      text = text
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
      total += text.length;

      const refs: string[] = [];
      const ops = await page.getOperatorList();
      let k = 0;
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (!paintOps.has(ops.fnArray[i])) continue;
        const arg = ops.argsArray[i]?.[0];
        const img = await imageOf(page, arg);
        if (!img || !img.data) continue;
        const key =
          img.ref ?? (typeof arg === 'string' ? arg : `inline-${n}-${i}`);
        if (seen.has(key)) {
          const ref = seen.get(key);
          if (ref) refs.push(`![p.${n} image](${ref})`);
          continue;
        }
        const kind = KIND[img.kind];
        if (!kind) continue;
        if (img.width < MIN_IMAGE_SIDE || img.height < MIN_IMAGE_SIDE) continue;
        if (img.width * img.height > MAX_PIXELS) {
          images.warn(
            `p.${n}: an image of ${img.width}×${img.height} px was skipped`,
          );
          seen.set(key, null);
          continue;
        }
        k++;
        const name = `p${n}-${k}.png`;
        const ref = images.add(
          name,
          encodePng(img.width, img.height, img.data, kind),
        );
        seen.set(key, ref);
        if (ref) refs.push(`![p.${n} image ${k}](${ref})`);
      }
      sections.push(
        `## p.${n}\n\n${[text, ...refs].filter(Boolean).join('\n')}`,
      );
      page.cleanup();
    }
    const noText = total < TEXT_THRESHOLD;
    if (noText && images.images.length > 0) {
      images.warn('no text layer; captured from page images');
    }
    return {
      markdown: sections.join('\n\n') + '\n',
      title: null,
      images: images.images,
      warnings: images.warnings(),
      empty: noText && images.images.length === 0,
    };
  } catch (err) {
    if ((err as { name?: string })?.name === 'PasswordException') {
      throw new Error('PDF is password protected', { cause: err });
    }
    throw new Error('Not a valid .pdf file', { cause: err });
  } finally {
    await task.destroy();
  }
}
