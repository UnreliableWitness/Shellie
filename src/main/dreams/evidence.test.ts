import { describe, expect, it } from 'vitest';
import type { TurnAt } from '../sessions/claudeTranscript';
import { DreamEvidenceSchema } from '../../shared/dreams';
import { cleanQuote, quoteWho } from './evidence';

const turn = (who: TurnAt['who'], text: string): TurnAt => ({
  who,
  text,
  at: 1,
});

const sessions: TurnAt[][] = [
  [
    turn('Developer', 'Please use named exports,   never default exports.'),
    turn('Claude', 'I added the timer to the README instead.'),
  ],
  [
    turn('Developer', 'Run the linter with pnpm lint before you say done.'),
    turn('Agent', 'Ran pnpm lint, no findings at all.'),
  ],
];

describe('cleanQuote', () => {
  it('strips a leading digest label, quotation marks and spare whitespace', () => {
    expect(cleanQuote('  **Developer:**  “use named\n  exports”  ')).toBe(
      'use named exports',
    );
    expect(cleanQuote('"**Claude:** I added it"')).toBe('I added it');
    expect(cleanQuote('**Agent:** done')).toBe('done');
  });

  it('cuts a quote at the first label inside it', () => {
    expect(
      cleanQuote(
        '**Developer:** Also add a line to CHANGELOG.md.\n\n**Claude:** I added the timer to the README instead.',
      ),
    ).toBe('Also add a line to CHANGELOG.md.');
  });
});

describe('quoteWho', () => {
  it('is you for words found inside one developer turn, whitespace collapsed', () => {
    expect(quoteWho('named exports, never default exports', sessions)).toBe(
      'you',
    );
    expect(
      quoteWho('**Developer:** Please use named exports, never', sessions),
    ).toBe('you');
  });

  it('is agent for words found inside one agent turn (Claude Code or OpenCode)', () => {
    expect(quoteWho('I added the timer to the README', sessions)).toBe('agent');
    expect(quoteWho('**Agent:** Ran pnpm lint, no findings', sessions)).toBe(
      'agent',
    );
  });

  it('is unknown when not found, too short, a different case, or across two turns', () => {
    expect(quoteWho('use tabs, never spaces anywhere', sessions)).toBe(
      'unknown',
    );
    expect(quoteWho('pnpm lint', sessions)).toBe('unknown');
    expect(quoteWho('PLEASE USE NAMED EXPORTS', sessions)).toBe('unknown');
    expect(quoteWho('never default exports. I added the timer', sessions)).toBe(
      'unknown',
    );
  });

  it('checks what precedes a label in the middle of a quote', () => {
    expect(
      quoteWho(
        '**Developer:** Run the linter with pnpm lint **Agent:** Ran pnpm lint',
        sessions,
      ),
    ).toBe('you');
  });
});

describe('whole words', () => {
  const dev = (text: string): TurnAt[][] => [[turn('Developer', text)]];

  it('is unknown for a match that starts or ends inside a word', () => {
    const s = dev("Don't refuse the helpers here");
    expect(quoteWho('use the helper', s)).toBe('unknown');
    expect(quoteWho('refuse the helper', s)).toBe('unknown');
    expect(quoteWho('fuse the helpers here', s)).toBe('unknown');
    expect(quoteWho('refuse the helpers here', s)).toBe('you');
  });

  it('takes a later whole-word match when an earlier one is mid-word', () => {
    expect(
      quoteWho('use the helper', dev('refuse the helpers, use the helper')),
    ).toBe('you');
  });

  it('counts accented letters as letters', () => {
    const s = dev('Schrijf élke logregel in het Engels');
    expect(quoteWho('lke logregel in het', s)).toBe('unknown');
    expect(quoteWho('élke logregel in het', s)).toBe('you');
  });

  it('needs at least three words', () => {
    const s = dev('Always internationalisation-first, please.');
    expect(quoteWho('internationalisation-first, please', s)).toBe('unknown');
    expect(quoteWho('Always internationalisation-first, please.', s)).toBe(
      'you',
    );
  });

  it('a quote that starts or ends with punctuation sits on a boundary', () => {
    const s = dev('See (a) keep the timer short.');
    expect(quoteWho('(a) keep the timer', s)).toBe('you');
  });
});

describe('quotation marks', () => {
  it('strips them only as a matching pair at both ends', () => {
    expect(cleanQuote('"use the helpers"')).toBe('use the helpers');
    expect(cleanQuote('‘use the helpers’')).toBe('use the helpers');
    expect(cleanQuote('«use the helpers»')).toBe('use the helpers');
    expect(cleanQuote("'use the helpers'")).toBe('use the helpers');
  });

  it('keeps a lone apostrophe inside or at the end of a word', () => {
    expect(cleanQuote("check the developers'")).toBe("check the developers'");
    expect(cleanQuote("don't touch the tests")).toBe("don't touch the tests");
    expect(cleanQuote("'tis the season of tests")).toBe(
      "'tis the season of tests",
    );
    expect(
      quoteWho("follow the developers' rules", [
        [turn('Developer', "Please follow the developers' rules here.")],
      ]),
    ).toBe('you');
  });
});

describe('a stored result from before the check', () => {
  it('reads evidence without who as unknown', () => {
    expect(
      DreamEvidenceSchema.parse({
        taskId: 't',
        label: 'l',
        date: 'd',
        quote: 'q',
      }).who,
    ).toBe('unknown');
  });
});
