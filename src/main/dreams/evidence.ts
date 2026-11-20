/**
 * Who said a quote a dream gives as evidence: Shellie checks it against the task's turns instead of trusting the
 * model. A proposal rests on what the developer said (spec section 4, "Changed during the build").
 */

import type { DreamEvidenceWho } from '../../shared/dreams';
import type { TurnAt } from '../sessions/claudeTranscript';

/** A digest's speaker label (`**Developer:**`, `**Claude:**`, `**Agent:**`), as `sessionDigest` writes it. */
const LABEL = /\*\*(?:Developer|Claude|Agent):\*\*/;
/** Quotation marks a model may put around a quote. */
const MARKS = /^["'“”‘’«»]+|["'“”‘’«»]+$/g;
/** Shorter quotes say too little to tell who said them. */
const MIN_LENGTH = 12;

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The quote as words to look for: a leading label, quotation marks and spare whitespace off; cut at a label inside. */
export function cleanQuote(quote: string): string {
  let q = quote.trim().replace(MARKS, '').trim();
  q = q.replace(new RegExp(`^${LABEL.source}`), '');
  const inner = LABEL.exec(q);
  if (inner) q = q.slice(0, inner.index);
  return collapse(q.trim().replace(MARKS, ''));
}

/**
 * `you` when the cleaned quote (at least 12 characters, case-sensitive, whitespace collapsed) lies inside one
 * developer turn of the sessions, `agent` inside one agent turn, else `unknown`.
 */
export function quoteWho(
  quote: string,
  sessions: readonly (readonly TurnAt[])[],
): DreamEvidenceWho {
  const q = cleanQuote(quote);
  if (q.length < MIN_LENGTH) return 'unknown';
  const turns = sessions.flat();
  const inside = (pick: (t: TurnAt) => boolean) =>
    turns.some((t) => pick(t) && collapse(t.text).includes(q));
  if (inside((t) => t.who === 'Developer')) return 'you';
  if (inside((t) => t.who !== 'Developer')) return 'agent';
  return 'unknown';
}
