import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from './png';

describe('encodePng', () => {
  it('writes an RGB image that decodes back to the same pixels', () => {
    const pixels = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const png = encodePng(2, 2, pixels, 'rgb');
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const back = decodePng(png);
    expect(back).toMatchObject({ width: 2, height: 2, colorType: 2 });
    expect(Buffer.concat(back.rows)).toEqual(Buffer.from(pixels));
  });

  it('keeps the alpha channel of RGBA pixels', () => {
    const pixels = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
    const back = decodePng(encodePng(2, 1, pixels, 'rgba'));
    expect(back.colorType).toBe(6);
    expect(Buffer.concat(back.rows)).toEqual(Buffer.from(pixels));
  });

  it('widens packed 1-bit grey rows to 8-bit grey', () => {
    // 10 pixels wide: two bytes per row, 0b10100000 0b01000000 -> 1,0,1,0,0,0,0,0,0,1
    const pixels = new Uint8Array([0b10100000, 0b01000000]);
    const back = decodePng(encodePng(10, 1, pixels, 'gray1'));
    expect(back.colorType).toBe(0);
    expect([...back.rows[0]]).toEqual([255, 0, 255, 0, 0, 0, 0, 0, 0, 255]);
  });
});
