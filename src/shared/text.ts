/** Small text helpers shared by main and the renderer. */

/** "1 file", "2 files"; pass `many` for an irregular plural. */
export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** `s` cut to at most `max` characters, ending in "…" when it was longer. */
export const clip = (s: string, max: number): string =>
  s.length <= max
    ? s
    : `${s.slice(0, max - 1).trimEnd()}${String.fromCharCode(0x2026)}`;

/** An amount in euros with two decimals, such as "€1.50"; rounds half up. */
export const eur = (n: number): string =>
  `${String.fromCharCode(0x20ac)}${(Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2)}`;
