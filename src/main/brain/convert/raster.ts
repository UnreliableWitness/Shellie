import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command, Platform } from '../../platform/Platform';
import type { Rasterize } from './types';

/** Formats @napi-rs/canvas decodes itself. */
const IN_PROCESS = new Set(['svg', 'bmp', 'ico']);
/** Longest side of a rasterised picture: a crafted SVG must not allocate gigabytes. */
export const MAX_RASTER_SIDE = 4000;

type Canvas = typeof import('@napi-rs/canvas');

let canvasModule: Promise<Canvas | null> | undefined;

/** The canvas package, or null when it is not installed or its binary cannot load (then rendering is skipped). */
export function loadCanvas(): Promise<Canvas | null> {
  canvasModule ??= import('@napi-rs/canvas').then(
    (m) => m,
    () => null,
  );
  return canvasModule;
}

/**
 * Once the main process is bundled, pdf.js cannot `require` the canvas package itself (its createRequire is
 * built on an import.meta.url that no longer exists), so the globals its renderer expects are set here and a
 * canvas factory is handed to getDocument.
 */
export function installCanvasGlobals(canvas: Canvas): void {
  const g = globalThis as Record<string, unknown>;
  g.DOMMatrix ??= canvas.DOMMatrix;
  g.Path2D ??= canvas.Path2D;
  g.ImageData ??= canvas.ImageData;
}

type CanvasAndContext = {
  canvas: { width: number; height: number } | null;
  context: unknown;
};

/** pdf.js's CanvasFactory contract (create, reset, destroy, getNoAlphaContext) on the canvas package. */
export function canvasFactoryFor(canvas: Canvas): new () => object {
  type Ctx2d = { getContext: (kind: '2d') => unknown };
  return class {
    create(width: number, height: number): CanvasAndContext {
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      const c = canvas.createCanvas(width, height);
      return { canvas: c, context: c.getContext('2d') };
    }
    getNoAlphaContext(c: Ctx2d): unknown {
      return c.getContext('2d');
    }
    reset(cc: CanvasAndContext, width: number, height: number): void {
      if (!cc.canvas) throw new Error('Canvas is not specified');
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      cc.canvas.width = width;
      cc.canvas.height = height;
    }
    destroy(cc: CanvasAndContext): void {
      if (!cc.canvas) throw new Error('Canvas is not specified');
      cc.canvas.width = cc.canvas.height = 0;
      cc.canvas = null;
      cc.context = null;
    }
  };
}

/** Most pixels a BMP or ICO may claim in its header: the decoder allocates the full bitmap before anything else. */
const MAX_BITMAP_PIXELS = 25_000_000;

/** The size a BMP or ICO header claims, read before decoding; null when the header is not there. */
export function bitmapSize(
  data: Buffer,
  ext: string,
): { width: number; height: number } | null {
  if (
    ext === 'bmp' &&
    data.length >= 26 &&
    data.toString('latin1', 0, 2) === 'BM'
  ) {
    return {
      width: Math.abs(data.readInt32LE(18)),
      height: Math.abs(data.readInt32LE(22)),
    };
  }
  if (ext === 'ico' && data.length >= 8) {
    // One directory entry per image; a byte of 0 means 256.
    return { width: data[6] || 256, height: data[7] || 256 };
  }
  return null;
}

/** SVG, BMP and ICO to PNG in process, scaled down to MAX_RASTER_SIDE when larger. */
export async function rasterizeInProcess(
  data: Buffer,
  ext: string,
): Promise<Buffer | null> {
  if (!IN_PROCESS.has(ext)) return null;
  const canvas = await loadCanvas();
  if (!canvas) return null;
  const claimed = bitmapSize(data, ext);
  if (claimed && claimed.width * claimed.height > MAX_BITMAP_PIXELS)
    return null;
  try {
    const img = await canvas.loadImage(data);
    if (!(img.width > 0 && img.height > 0)) return null;
    const scale = Math.min(
      1,
      MAX_RASTER_SIDE / Math.max(img.width, img.height),
    );
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = canvas.createCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return Buffer.from(await c.encode('png'));
  } catch {
    return null;
  }
}

export type RunCommand = (
  cmd: Command,
  o: { cwd: string; input: string; timeoutMs: number },
) => Promise<string>;

const COMMAND_TIMEOUT_MS = 30_000;

/**
 * The app's rasterizer: in process first, then the platform's own image tool (PowerShell's System.Drawing on
 * Windows, sips on macOS) through temp files. Null for anything neither can do.
 */
export function createRasterizer(deps: {
  platform: Pick<Platform, 'rasterizeCommand'>;
  run: RunCommand;
}): Rasterize {
  return async (data, ext) => {
    const inProcess = await rasterizeInProcess(data, ext);
    if (inProcess) return inProcess;
    if (!deps.platform.rasterizeCommand) return null;
    let dir: string | null = null;
    try {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-raster-'));
      const src = path.join(dir, `picture.${ext}`);
      const dest = path.join(dir, 'picture.png');
      const cmd = deps.platform.rasterizeCommand(src, dest);
      if (!cmd) return null;
      await fs.writeFile(src, data);
      await deps.run(cmd, {
        cwd: dir,
        input: '',
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      const png = await fs.readFile(dest);
      return png.length > 0 ? png : null;
    } catch {
      return null;
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  };
}
