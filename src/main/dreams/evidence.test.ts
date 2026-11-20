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
