import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Command } from '../../platform/Platform';
import { createRasterizer, loadCanvas, rasterizeInProcess } from './raster';

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
