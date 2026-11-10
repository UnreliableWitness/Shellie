import type {
  BrainConflictRow,
  ConflictClaim,
  SettleChoice,
} from '../../../../shared/brain';

/** A choice, or asking someone first: the settle card's radio values. */
export type CardChoice = SettleChoice | 'ask';

/** The choices a conflict offers: an older finding (no claims) has only Write what is true and Re-check. */
export function choicesFor(row: BrainConflictRow): CardChoice[] {
  if (!row.conflict) return ['write'];
  if (row.kind === 'scope-change') return ['accept', 'keep', 'ask'];
  return ['a', 'b', 'both', 'neither', 'ask'];
}

/** Choices that need a sentence from the person. */
export const NEEDS_TEXT: ReadonlySet<CardChoice> = new Set([
  'both',
  'neither',
  'write',
]);

export const CHOICE_LABEL: Record<CardChoice, string> = {
  a: 'A is right',
  b: 'B is right',
  both: 'Both, in different contexts',
  neither: 'Neither',
  accept: 'Accept: this is the new scope',
  keep: 'Keep the agreed scope',
  write: 'Write what is true',
  ask: 'I need to ask someone',
};

/** The Settle button for a choice: "Settle: B is right". */
export const SETTLE_LABEL: Record<SettleChoice, string> = {
  a: 'Settle: A is right',
  b: 'Settle: B is right',
  both: 'Settle: both',
  neither: 'Settle: neither',
  accept: 'Settle: accept the new scope',
  keep: 'Settle: keep the agreed scope',
  write: 'Settle: write what is true',
};

/** One line for a settled conflict in the list. */
export function choiceLine(choice: SettleChoice, text: string | null): string {
  switch (choice) {
    case 'a':
      return 'A is right';
    case 'b':
      return 'B is right';
    case 'both':
      return `Both: ${text ?? ''}`;
    case 'neither':
      return `Neither: ${text ?? ''}`;
    case 'accept':
      return 'New scope accepted';
    case 'keep':
      return 'Agreed scope kept';
    default:
      return text ?? '';
  }
}

export const fileName = (p: string) => p.split('/').pop() ?? p;

/** The later of two claims, when both have a date and they differ. */
export function newerOf(a: ConflictClaim, b: ConflictClaim): 'a' | 'b' | null {
  if (!a.date || !b.date || a.date === b.date) return null;
  return a.date > b.date ? 'a' : 'b';
}

const said = (c: ConflictClaim, titleOf: (p: string) => string) => {
  const where = [c.source ? fileName(c.source) : null, c.date].filter(Boolean);
  return `${titleOf(c.page)}${where.length ? ` (${where.join(', ')})` : ''} says "${c.quote}"`;
};

/** A question someone can answer without opening the brain, written from both claims. */
export function defaultQuestion(
  row: BrainConflictRow,
  titleOf: (p: string) => string,
): string {
  const c = row.conflict;
  if (!c) return `About ${titleOf(row.page)}: ${row.detail}. What is right?`;
  return `${c.question} ${said(c.claims.a, titleOf)}; ${said(c.claims.b, titleOf)}. Which is current?`;
}
