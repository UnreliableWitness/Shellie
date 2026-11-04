export type ConvertedImage = { name: string; data: Buffer };

export type Converted = {
  /** Images are referenced as `{{assets}}/<name>`; addSource replaces the placeholder with the assets folder. */
  markdown: string;
  title: string | null;
  images: ConvertedImage[];
  warnings: string[];
  /** No text and no images: nothing Claude can read. */
  empty: boolean;
};

/** Where image references point before the source has a name. */
export const ASSETS_PLACEHOLDER = '{{assets}}';

/** Formats Claude Code's Read tool shows as a picture. */
export const VIEWABLE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** Most images one source may bring along. */
export const MAX_IMAGES = 60;

/** Collects a source's images under the cap and remembers what could not be taken. */
export class ImageCollector {
  readonly images: ConvertedImage[] = [];
  private overCap = 0;
  private readonly unviewable = new Map<string, number>();
  private readonly extra: string[] = [];

  /** Takes a viewable image; returns the markdown path to reference it by, or null when the cap is reached. */
  add(name: string, data: Buffer): string | null {
    if (this.images.length >= MAX_IMAGES) {
      this.overCap++;
      return null;
    }
    this.images.push({ name, data });
    return `${ASSETS_PLACEHOLDER}/${name}`;
  }

  /** The path an already taken image is referenced by. */
  ref(name: string): string {
    return `${ASSETS_PLACEHOLDER}/${name}`;
  }

  /** Counts a picture in a format Claude cannot view. */
  skip(ext: string): void {
    const key = ext.toLowerCase() || 'unknown';
    this.unviewable.set(key, (this.unviewable.get(key) ?? 0) + 1);
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
        `${n} picture${n === 1 ? '' : 's'} in formats Claude cannot view (${formats})`,
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
