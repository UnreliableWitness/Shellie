import zlib from 'node:zlib';

/** Pixel layouts pdf.js hands out: packed 1-bit grey (rows padded to a byte), RGB or RGBA, 8 bits per channel. */
export type PixelKind = 'gray1' | 'rgb' | 'rgba';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes raw pixels as a PNG (no dependencies). 1-bit grey is widened to 8-bit grey. */
export function encodePng(
  width: number,
  height: number,
  pixels: Uint8Array | Uint8ClampedArray,
  kind: PixelKind,
): Buffer {
  const channels = kind === 'rgb' ? 3 : kind === 'rgba' ? 4 : 1;
  const colorType = kind === 'rgb' ? 2 : kind === 'rgba' ? 6 : 0;
  const rowBytes = width * channels;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  if (kind === 'gray1') {
    const srcRow = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      const o = y * (rowBytes + 1);
      raw[o] = 0;
      for (let x = 0; x < width; x++) {
        const bit = (pixels[y * srcRow + (x >> 3)] >> (7 - (x & 7))) & 1;
        raw[o + 1 + x] = bit ? 255 : 0;
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      const o = y * (rowBytes + 1);
      raw[o] = 0;
      raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), o + 1);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Reads back width, height, colour type and the unfiltered pixel rows of a PNG this module wrote (tests). */
export function decodePng(png: Buffer): {
  width: number;
  height: number;
  colorType: number;
  rows: Buffer[];
} {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25];
  let pos = 8;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const stride = width * channels + 1;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(raw.subarray(y * stride + 1, (y + 1) * stride));
  }
  return { width, height, colorType, rows };
}
