import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command, Platform } from '../../platform/Platform';
import type { Rasterize } from './types';

/** Formats @napi-rs/canvas decodes itself. */
const IN_PROCESS = new Set(['svg', 'bmp', 'ico']);

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

/** SVG, BMP and ICO to PNG in process. */
export async function rasterizeInProcess(
  data: Buffer,
  ext: string,
): Promise<Buffer | null> {
  if (!IN_PROCESS.has(ext)) return null;
  const canvas = await loadCanvas();
  if (!canvas) return null;
  try {
    const img = await canvas.loadImage(data);
    if (!(img.width > 0 && img.height > 0)) return null;
    const c = canvas.createCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
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
