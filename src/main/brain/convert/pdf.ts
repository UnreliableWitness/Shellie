import { encodePng, type PixelKind } from './png';
import { canvasFactoryFor, installCanvasGlobals, loadCanvas } from './raster';
import { ImageCollector, type ConvertOptions, type Converted } from './types';

const TEXT_THRESHOLD = 20;
/** Bullets, rules and icons: not worth a look. */
const MIN_IMAGE_SIDE = 48;
const MAX_PIXELS = 25_000_000;
/** A page with this many drawn paths covering this share of the page carries a drawing, not rules or a logo. */
const DRAWING_MIN_PATHS = 8;
const DRAWING_MIN_AREA = 0.05;
/** Most pages rendered per PDF, and the longer side of a render. */
export const MAX_PAGE_RENDERS = 20;
const RENDER_SIDE = 1600;

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

type OperatorList = Awaited<ReturnType<Page['getOperatorList']>>;

/** The operator codes hasDrawing reads (pdf.js OPS). */
export type DrawingOps = {
  constructPath: number;
  endPath: number;
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
};

type Matrix = [number, number, number, number, number, number];

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

/** A path's box in page units: its corners through the current transform. */
function pageBox(box: ArrayLike<number>, ctm: Matrix): [number, number] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[0], box[3]],
    [box[2], box[3]],
  ]) {
    xs.push(ctm[0] * x + ctm[2] * y + ctm[4]);
    ys.push(ctm[1] * x + ctm[3] * y + ctm[5]);
  }
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

/**
 * Whether the page's paths add up to a drawing: enough painted paths (clips do not count), covering enough
 * of the page between them (a full-page background does not count), measured in page units through the
 * current transform.
 */
export function hasDrawing(
  ops: OperatorList,
  codes: DrawingOps,
  pageWidth: number,
  pageHeight: number,
): boolean {
  const pageArea = pageWidth * pageHeight;
  if (!(pageArea > 0)) return false;
  let paths = 0;
  let area = 0;
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[] | undefined;
    if (fn === codes.save) stack.push(ctm);
    else if (fn === codes.restore) ctm = stack.pop() ?? ctm;
    else if (fn === codes.transform && args && args.length >= 6) {
      ctm = mul(args.slice(0, 6) as Matrix, ctm);
    } else if (fn === codes.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0] as ArrayLike<number> | null | undefined;
      if (m && m.length >= 6)
        ctm = mul(Array.from(m).slice(0, 6) as Matrix, ctm);
    } else if (fn === codes.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === codes.constructPath) {
      // args: [painting op, path data, bounding box [minX, minY, maxX, maxY]]
      if (args?.[0] === codes.endPath) continue; // a clip, not a drawing
      const box = args?.[2] as ArrayLike<number> | undefined;
      if (!box || box.length < 4) continue;
      const [w, h] = pageBox(box, ctm);
      const a = Math.min(w, pageWidth) * Math.min(h, pageHeight);
      if (a / pageArea >= 0.9) continue; // the page background
      paths++;
      area += a;
    }
  }
  return (
    paths >= DRAWING_MIN_PATHS &&
    Math.min(area, pageArea) / pageArea >= DRAWING_MIN_AREA
  );
}

/** Renders the page to PNG bytes with the canvas package; null when it is not available. */
async function renderPage(page: Page): Promise<Buffer | null> {
  const canvas = await loadCanvas();
  if (!canvas) return null;
  const base = page.getViewport({ scale: 1 });
  const scale = RENDER_SIDE / Math.max(base.width, base.height, 1);
  const viewport = page.getViewport({ scale });
  const c = canvas.createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({
    canvas: c as unknown as HTMLCanvasElement,
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  return Buffer.from(await c.encode('png'));
}

export async function pdfToMarkdown(
  buf: Uint8Array,
  opts: ConvertOptions = {},
): Promise<Converted> {
  const canvas = await loadCanvas();
  if (canvas) installCanvasGlobals(canvas);
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
    ...(canvas ? { CanvasFactory: canvasFactoryFor(canvas) } : {}),
  });
  const drawingOps: DrawingOps = {
    constructPath: pdfjs.OPS.constructPath,
    endPath: pdfjs.OPS.endPath,
    save: pdfjs.OPS.save,
    restore: pdfjs.OPS.restore,
    transform: pdfjs.OPS.transform,
    paintFormXObjectBegin: pdfjs.OPS.paintFormXObjectBegin,
    paintFormXObjectEnd: pdfjs.OPS.paintFormXObjectEnd,
  };
  const paintOps = new Set([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
  ]);
  try {
    const doc = await task.promise;
    const sections: string[] = [];
    const images = new ImageCollector(opts.rasterize);
    // Object reference (or name) -> markdown path, so an image painted on several pages is stored once.
    const seen = new Map<string, string | null>();
    let total = 0;
    let renders = 0;
    let unrendered = 0;
    let canvasMissing = false;
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
      const view = page.getViewport({ scale: 1 });
      // A page with a drawing is shown as drawn; its own pictures are part of that render.
      let rendered = false;
      if (hasDrawing(ops, drawingOps, view.width, view.height)) {
        if (renders >= MAX_PAGE_RENDERS) unrendered++;
        else {
          let png: Buffer | null = null;
          try {
            png = await renderPage(page);
            if (!png) canvasMissing = true;
          } catch (e) {
            // The text and the page's own pictures still go through.
            images.warn(
              `p.${n}: the drawing could not be rendered (${e instanceof Error ? e.message : String(e)})`,
            );
          }
          if (png) {
            renders++;
            const ref = images.add(`p${n}.png`, png);
            if (ref) {
              refs.push(`![p.${n} as drawn](${ref})`);
              rendered = true;
            }
          }
        }
      }
      let k = 0;
      for (let i = 0; i < ops.fnArray.length && !rendered; i++) {
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
    if (canvasMissing) {
      images.warn('pages with drawings were not rendered: canvas unavailable');
    }
    if (unrendered > 0) {
      images.warn(
        `${unrendered} more page${unrendered === 1 ? '' : 's'} with drawings not rendered (limit ${MAX_PAGE_RENDERS})`,
      );
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
