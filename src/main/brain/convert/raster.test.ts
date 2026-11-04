import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Command } from '../../platform/Platform';
import {
  MAX_RASTER_SIDE,
  bitmapSize,
  createRasterizer,
  loadCanvas,
  rasterizeInProcess,
} from './raster';

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#ff0000"/></svg>',
);

/** A 2×2 24-bit BMP, all blue. */
function bmp(): Buffer {
  const rowBytes = 8; // 2 px * 3 bytes, padded to 4
  const pixels = Buffer.alloc(rowBytes * 2);
  for (const y of [0, 1])
    for (const x of [0, 1]) pixels.set([255, 0, 0], y * rowBytes + x * 3);
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(2, 18);
  header.writeInt32LE(2, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([header, pixels]);
}

describe('rasterizeInProcess', () => {
  it('turns an SVG into a PNG of the same size', async () => {
    expect(await loadCanvas()).not.toBeNull();
    const png = await rasterizeInProcess(SVG, 'svg');
    expect(png).not.toBeNull();
    // The canvas encoder filters its rows, so read the result back through the canvas, not decodePng.
    const canvas = (await loadCanvas())!;
    const img = await canvas.loadImage(png!);
    expect([img.width, img.height]).toEqual([40, 20]);
    const c = canvas.createCanvas(40, 20);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    expect([...ctx.getImageData(5, 5, 1, 1).data]).toEqual([255, 0, 0, 255]);
  });

  it('turns a BMP into a PNG', async () => {
    const png = await rasterizeInProcess(bmp(), 'bmp');
    expect(png).not.toBeNull();
    const img = await (await loadCanvas())!.loadImage(png!);
    expect([img.width, img.height]).toEqual([2, 2]);
  });

  it('scales a huge SVG down to the longest-side cap', async () => {
    const huge = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="10000"><rect width="20000" height="10000" fill="#00ff00"/></svg>',
    );
    const png = await rasterizeInProcess(huge, 'svg');
    expect(png).not.toBeNull();
    const img = await (await loadCanvas())!.loadImage(png!);
    expect([img.width, img.height]).toEqual([
      MAX_RASTER_SIDE,
      MAX_RASTER_SIDE / 2,
    ]);
  });

  it('refuses a BMP or ICO whose header claims a huge bitmap before decoding it', async () => {
    const huge = bmp();
    huge.writeInt32LE(16000, 18);
    huge.writeInt32LE(-16000, 22);
    expect(bitmapSize(huge, 'bmp')).toEqual({ width: 16000, height: 16000 });
    expect(await rasterizeInProcess(huge, 'bmp')).toBeNull();
    expect(bitmapSize(bmp(), 'bmp')).toEqual({ width: 2, height: 2 });
    expect(bitmapSize(Buffer.from('x'), 'svg')).toBeNull();
  });

  it('reads the real size of the pictures inside an ICO', async () => {
    // One entry whose directory bytes say 256×256 but whose data is a PNG header claiming 12000×12000.
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12);
    png.writeUInt32BE(12000, 16);
    png.writeUInt32BE(12000, 20);
    const ico = Buffer.alloc(6 + 16);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(1, 4);
    ico.writeUInt32LE(png.length, 6 + 8);
    ico.writeUInt32LE(ico.length, 6 + 12);
    const file = Buffer.concat([ico, png]);
    expect(bitmapSize(file, 'ico')).toEqual({ width: 12000, height: 12000 });
    expect(await rasterizeInProcess(file, 'ico')).toBeNull();
    // A bitmap entry: the DIB header carries the width and the doubled height.
    const dib = Buffer.alloc(40);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(48, 4);
    dib.writeInt32LE(96, 8);
    const ico2 = Buffer.concat([ico, dib]);
    expect(bitmapSize(ico2, 'ico')).toEqual({ width: 48, height: 48 });
    // No data to read: the directory bytes (0 means 256).
    expect(bitmapSize(Buffer.alloc(6 + 16), 'ico')).toEqual({
      width: 256,
      height: 256,
    });
    // The refusal also keeps the platform tool out of it.
    let ran = false;
    const raster = createRasterizer({
      platform: { rasterizeCommand: () => ({ command: 'conv', args: [] }) },
      run: async () => {
        ran = true;
        return '';
      },
    });
    const huge = bmp();
    huge.writeInt32LE(16000, 18);
    huge.writeInt32LE(16000, 22);
    expect(await raster(huge, 'bmp')).toBeNull();
    expect(ran).toBe(false);
  });

  it('is null for formats it does not decode and for broken input', async () => {
    expect(await rasterizeInProcess(Buffer.from('x'), 'tiff')).toBeNull();
    expect(await rasterizeInProcess(Buffer.from('not svg'), 'svg')).toBeNull();
  });
});

describe('createRasterizer', () => {
  it('falls back to the platform command through temp files and cleans up', async () => {
    const dirs: string[] = [];
    const raster = createRasterizer({
      platform: {
        rasterizeCommand: (src, dest) =>
          src.endsWith('.emf') ? { command: 'conv', args: [src, dest] } : null,
      },
      run: async (cmd: Command) => {
        dirs.push(path.dirname(cmd.args[1]));
        expect(await fs.readFile(cmd.args[0], 'utf8')).toBe('emf-bytes');
        await fs.writeFile(cmd.args[1], 'png-bytes');
        return '';
      },
    });
    expect((await raster(Buffer.from('emf-bytes'), 'emf'))?.toString()).toBe(
      'png-bytes',
    );
    expect(await raster(Buffer.from('x'), 'tiff')).toBeNull();
    expect(dirs).toHaveLength(1);
    await expect(fs.stat(dirs[0])).rejects.toThrow();
  });

  it('is null when the command fails or writes nothing', async () => {
    const raster = createRasterizer({
      platform: { rasterizeCommand: () => ({ command: 'conv', args: [] }) },
      run: async () => {
        throw new Error('boom');
      },
    });
    expect(await raster(Buffer.from('x'), 'emf')).toBeNull();
    const empty = createRasterizer({
      platform: { rasterizeCommand: () => ({ command: 'conv', args: [] }) },
      run: async () => '',
    });
    expect(await empty(Buffer.from('x'), 'wmf')).toBeNull();
  });

  it('is null without a platform command', async () => {
    const raster = createRasterizer({ platform: {}, run: async () => '' });
    expect(await raster(Buffer.from('x'), 'emf')).toBeNull();
    // In-process formats still work.
    expect(await raster(SVG, 'svg')).not.toBeNull();
  });
});
