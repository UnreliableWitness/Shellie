/** The hint under an empty ask box. */
export const ASK_HINT = 'Enter sends · Shift+Enter starts a new line';

/** How long a run took, in words: "18 s", "1 min 12 s", "2 min"; no seconds from ten minutes on. */
export function tookWords(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60);
  const s = total % 60;
  if (min >= 10) return `${Math.round(total / 60)} min`;
  return s === 0 ? `${min} min` : `${min} min ${s} s`;
}
