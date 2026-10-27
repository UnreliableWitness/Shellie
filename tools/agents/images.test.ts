import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadImages, imageKind, imageUrls } from './images.mjs';

const A =
  'https://github.com/user-attachments/assets/ad1e2805-3789-4d6b-8579-43f4ae576bbd';
const B = 'https://private-user-images.githubusercontent.com/1/2-abc.png?jwt=x';
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

describe('imageUrls', () => {
  it('finds GitHub-hosted images in markdown and HTML, once each', () => {
    const text = `<img width="1423" alt="Image" src="${A}" />\n\n![shot](${B})\n![again](${A})`;
    expect(imageUrls([text])).toEqual([A, B]);
  });
  it('ignores images on other hosts and plain links', () => {
    expect(
      imageUrls([
        '![x](https://evil.example/a.png) see https://github.com/user-attachments/files/1/log.txt',
      ]),
    ).toEqual([]);
  });
  it('keeps at most five', () => {
    const many = Array.from(
      { length: 8 },
      (_, i) =>
        `![${i}](https://github.com/user-attachments/assets/${i}aaaaaaa-0000-0000-0000-000000000000)`,
    ).join(' ');
    expect(imageUrls([many])).toHaveLength(5);
  });
});

describe('imageKind', () => {
  it('recognises PNG, JPEG, GIF and WebP by their first bytes, nothing else', () => {
    expect(imageKind(PNG)).toBe('png');
    expect(imageKind(JPEG)).toBe('jpg');
    expect(imageKind(Buffer.from('GIF89a....'))).toBe('gif');
    expect(
      imageKind(
        Buffer.concat([
          Buffer.from('RIFF'),
          Buffer.alloc(4),
          Buffer.from('WEBP'),
        ]),
      ),
    ).toBe('webp');
    expect(imageKind(Buffer.from('<html>not an image'))).toBeNull();
  });
});

describe('downloadImages', () => {
  it('saves real images under the folder and skips the rest, never failing the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-'));
    const bodies: Record<string, Buffer | Error> = {
      [A]: PNG,
      [B]: Buffer.from('<html>login</html>'),
      'https://github.com/user-attachments/assets/c': new Error('network'),
    };
    const fetchStub = async (url: string) => {
      const b = bodies[url];
      if (b instanceof Error) throw b;
      return { ok: true, arrayBuffer: async () => b };
    };
    const saved = await downloadImages(
      [A, B, 'https://github.com/user-attachments/assets/c'],
      dir,
      { fetch: fetchStub as never, prefix: '.agent-images/132' },
    );
    expect(saved).toEqual([{ url: A, file: '.agent-images/132/1.png' }]);
    expect(readdirSync(dir)).toEqual(['1.png']);
  });
  it('skips an image over the size limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-'));
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    const saved = await downloadImages([A], dir, {
      fetch: (async () => ({
        ok: true,
        arrayBuffer: async () => big,
      })) as never,
      prefix: 'x',
    });
    expect(saved).toEqual([]);
  });
});
