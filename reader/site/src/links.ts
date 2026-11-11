/** Links inside a text: what a relative one points at, and the small words the views share. */

export const isWeb = (href: string) => /^https?:\/\//i.test(href);
export const hasScheme = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href);

export function decodeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
}

/**
 * The path in the brain a relative link points at, from the path of the text it is in; null when it leaves the
 * brain. The same rule as Shellie's `resolveRelative` (src/renderer/docs/linkify.ts), which cannot be imported
 * here: that module talks to Electron.
 */
export function resolveRelative(fromDoc: string, href: string): string | null {
  const bare = href.split('#')[0].split('?')[0];
  const decoded = decodeAnchor(bare);
  const parts = decoded.startsWith('/') ? [] : fromDoc.split('/').slice(0, -1);
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** A `yyyy-mm-dd` day (or a timestamp) as "4 Nov"; the text as it is when it is not a day. */
export function shortDay(day: string | null): string {
  if (!day) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

/** Minutes as "50 min" or "1 h 50 min". */
export function duration(minutes: number): string {
  const all = Math.max(0, Math.round(minutes));
  const h = Math.floor(all / 60);
  const m = all % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
