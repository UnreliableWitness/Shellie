/**
 * Who said a quote a dream gives as evidence: Shellie checks it against the task's turns instead of trusting the
 * model. A proposal rests on what the developer said (spec section 4, "Changed during the build").
 */

import type { DreamEvidenceWho } from '../../shared/dreams';
import type { TurnAt } from '../sessions/claudeTranscript';

/** A digest's speaker label (`**Developer:**`, `**Claude:**`, `**Agent:**`), as `sessionDigest` writes it. */
const LABEL = /\*\*(?:Developer|Claude|Agent):\*\*/;
/** Quotation marks a model may put around a quote, as opening and closing pairs. */
const PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['”', '”'],
  ['„', '“'],
  ['‘', '’'],
  ['«', '»'],
  ['»', '«'],
];
/** Shorter quotes say too little to tell who said them. */
const MIN_LENGTH = 12;
const MIN_WORDS = 3;
const WORD_CHAR = /[\p{L}\p{N}]/u;

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Strips quotation marks around the whole quote, only as a matching pair (never a lone apostrophe). */
function unwrap(q: string): string {
  for (;;) {
    const t = q.trim();
    const pair = PAIRS.find(
      ([open, close]) =>
        t.length >= 2 && t.startsWith(open) && t.endsWith(close),
    );
    if (!pair) return t;
    q = t.slice(1, -1);
  }
}

/** The quote as words to look for: a leading label, quotation marks and spare whitespace off; cut at a label inside. */
export function cleanQuote(quote: string): string {
  let q = unwrap(quote);
  q = q.replace(new RegExp(`^${LABEL.source}`), '');
  const inner = LABEL.exec(q);
  if (inner) q = q.slice(0, inner.index);
  return collapse(unwrap(q));
}

const words = (q: string): number =>
  q.split(' ').filter((w) => WORD_CHAR.test(w)).length;

const ENDS_IN_WORD = /[\p{L}\p{M}\p{N}]$/u;
const STARTS_IN_WORD = /^[\p{L}\p{M}\p{N}]/u;

/**
 * `q` lies in `text` on word boundaries: no letter or digit runs on across either end of the match (Unicode, so
 * accented words count); the start or end of the text is a boundary. Also when the quote's first or last character
 * is punctuation: `'t use the helper` is not found inside `Don't use the helper`.
 */
function containsWords(text: string, q: string): boolean {
  for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + 1)) {
    if (ENDS_IN_WORD.test(text.slice(0, at))) continue;
    if (STARTS_IN_WORD.test(text.slice(at + q.length))) continue;
    return true;
  }
  return false;
}

/**
 * `you` when the cleaned quote (at least 12 characters and 3 words, case-sensitive, whitespace collapsed) lies inside
 * one developer turn of the sessions on word boundaries at both ends, `agent` inside one agent turn, else `unknown`.
 */
export function quoteWho(
  quote: string,
  sessions: readonly (readonly TurnAt[])[],
): DreamEvidenceWho {
  const q = cleanQuote(quote);
  if (q.length < MIN_LENGTH || words(q) < MIN_WORDS) return 'unknown';
  const turns = sessions.flat();
  const inside = (pick: (t: TurnAt) => boolean) =>
    turns.some((t) => pick(t) && containsWords(collapse(t.text), q));
  if (inside((t) => t.who === 'Developer')) return 'you';
  if (inside((t) => t.who !== 'Developer')) return 'agent';
  return 'unknown';
}
