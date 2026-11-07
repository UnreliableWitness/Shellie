import { pictureLabel } from '../pictureLabel';

export type ConvertedImage = { name: string; data: Buffer };

/** A picture the converter could not take: where it was, why, and what the owner can do about it. */
export type DroppedPicture = { where: string; reason: string; fix: string };

export type Converted = {
  /** Images are referenced as `{{assets}}/<name>`; addSource replaces the placeholder with the assets folder. */
  markdown: string;
  title: string | null;
  images: ConvertedImage[];
  warnings: string[];
  /** Each picture that could not be taken, one entry per picture. */
  dropped: DroppedPicture[];
  /** Pictures too small to be worth a look (bullets, icons), counted only. */
  tiny: number;
  /** No text and no images: nothing Claude can read. */
  empty: boolean;
};

/** Where image references point before the source has a name. */
export const ASSETS_PLACEHOLDER = '{{assets}}';

/** Formats Claude Code's Read tool shows as a picture. */
export const VIEWABLE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
/** Picture formats the agent cannot view as they are (a file in one of these is a picture that did not reach the agent). */
export const PICTURE_FORMATS = new Set([
  'svg',
  'emf',
  'wmf',
  'tif',
  'tiff',
  'bmp',
  'ico',
  'heic',
  'heif',
]);

/** Most images one source may bring along. */
export const MAX_IMAGES = 60;

const OVER_CAP: Omit<DroppedPicture, 'where'> = {
  reason: `over the ${MAX_IMAGES}-picture limit`,
  fix: 'Split the file, or remove pictures that carry nothing, then remove the source and add it again',
};

/** Why a picture in a format the agent cannot view was not taken, and what to do about it. */
function notConverted(ext: string): Omit<DroppedPicture, 'where'> {
  const e = (ext || 'unknown').toUpperCase();
  if (e === 'EMF' || e === 'WMF') {
    return {
      reason: `${e} converts on Windows only`,
      fix: 'Remove the source and add it again on Windows, or save the picture as PNG in the file',
    };
  }
  return {
    reason: `${e} could not be converted`,
    fix: 'Save the picture as PNG in the file, then remove the source and add it again',
  };
}

/** Where a picture sits, from the name its converter gives it: `slide-9-2` is 'Slide 9, picture 2', `p3` 'Page 3'. */
export function pictureWhere(name: string): string {
  const base = name.replace(/\.[^.]*$/, '');
  const k = /^(?:slide-\d+|p\d+|sheet-\d+)-(\d+)$/.exec(base)?.[1];
  return k ? `${pictureLabel(base)}, picture ${k}` : pictureLabel(base);
}

/** Turns a picture in another format into PNG bytes; null when it cannot. Never throws. */
export type Rasterize = (data: Buffer, ext: string) => Promise<Buffer | null>;

export type ConvertOptions = { rasterize?: Rasterize };

/** Collects a source's images under the cap and remembers what could not be taken. */
export class ImageCollector {
  readonly images: ConvertedImage[] = [];
  readonly dropped: DroppedPicture[] = [];
  /** Pictures too small to be worth a look. */
  tiny = 0;
  private overCap = 0;
  private readonly unviewable = new Map<string, number>();
  private readonly extra: string[] = [];

  /** The format of the last picture that could not be taken, so a converter can say so in place. */
  lastSkipped: string | null = null;

  constructor(private readonly rasterize?: Rasterize) {}

  /** Takes a picture in any format: viewable ones as they are, others as PNG through the rasterize hook. */
  async addAny(
    stem: string,
    data: Buffer,
    ext: string,
    where: string = pictureWhere(stem),
  ): Promise<string | null> {
    const e = ext.toLowerCase();
    this.lastSkipped = null;
    if (VIEWABLE.has(e))
      return this.add(`${stem}.${e === 'jpeg' ? 'jpg' : e}`, data, where);
    const png = this.rasterize ? await this.rasterize(data, e) : null;
    if (!png) {
      this.skip(e);
      this.lastSkipped = e;
      const { reason, fix } = notConverted(e);
      this.drop(where, reason, fix);
      return null;
    }
    return this.add(`${stem}.png`, png, where);
  }

  /** Takes a viewable image; returns the markdown path to reference it by, or null when the cap is reached. */
  add(
    name: string,
    data: Buffer,
    where: string = pictureWhere(name),
  ): string | null {
    if (this.images.length >= MAX_IMAGES) {
      this.overCap++;
      this.drop(where, OVER_CAP.reason, OVER_CAP.fix);
      return null;
    }
    this.images.push({ name, data });
    return `${ASSETS_PLACEHOLDER}/${name}`;
  }

  /** The path an already taken image is referenced by. */
  ref(name: string): string {
    return `${ASSETS_PLACEHOLDER}/${name}`;
  }

  /** Counts a picture in a format the agent cannot view. */
  skip(ext: string): void {
    const key = ext.toLowerCase() || 'unknown';
    this.unviewable.set(key, (this.unviewable.get(key) ?? 0) + 1);
  }

  /** Records one picture that could not be taken. */
  drop(where: string, reason: string, fix: string): void {
    this.dropped.push({ where, reason, fix });
  }

  /** Counts a picture too small to be worth a look. */
  tinyImage(): void {
    this.tiny++;
  }

  warn(message: string): void {
    this.extra.push(message);
  }

  warnings(): string[] {
    const out = [...this.extra];
    const n = [...this.unviewable.values()].reduce((a, b) => a + b, 0);
    if (n > 0) {
      const formats = [...this.unviewable.keys()].sort().join(', ');
      out.push(
        `${n} picture${n === 1 ? '' : 's'} in formats the agent cannot view (${formats})`,
      );
    }
    if (this.overCap > 0) {
      out.push(
        `${this.overCap} more picture${this.overCap === 1 ? '' : 's'} not extracted (limit ${MAX_IMAGES})`,
      );
    }
    return out;
  }
}

/** Extension (without the dot, lower case) of a media path or content type. */
export function imageExt(pathOrType: string): string {
  const m = /^image\/([a-z0-9.+-]+)$/i.exec(pathOrType);
  if (m) {
    const t = m[1].toLowerCase();
    if (t === 'jpeg') return 'jpg';
    if (t === 'svg+xml') return 'svg';
    if (t === 'x-emf') return 'emf';
    if (t === 'x-wmf') return 'wmf';
    return t;
  }
  const dot = pathOrType.lastIndexOf('.');
  return dot < 0 ? '' : pathOrType.slice(dot + 1).toLowerCase();
}

/** First `# ` heading of a markdown text, or null. */
export function firstHeading(markdown: string): string | null {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return m ? m[1].trim() : null;
}
