import { describe, expect, it } from 'vitest';
import { answerFileText, answerLine, sendAnswer } from './sendAnswer';

function deps(
  pick:
    | { tab: { id: string; cwd: string } }
    | { reason: 'none' | 'busy' | 'typing' },
) {
  const written: [string, string][] = [];
  const typed: [string, string][] = [];
  return {
    written,
    typed,
    d: {
      pick: async () => pick,
      nextFile: async () => '.shellie/brain-answer-3.md',
      write: async (abs: string, text: string) => {
        written.push([abs, text]);
      },
      type: (id: string, data: string) => {
        typed.push([id, data]);
      },
    },
  };
}

describe('sendAnswer', () => {
  it("writes the answer in the tab's folder and types one line without Enter", async () => {
    const { d, written, typed } = deps({ tab: { id: 'a', cwd: '/w/repo' } });
    expect(await sendAnswer(d, 'What\nwas decided?', 'Semicolons.')).toEqual({
      ok: true,
      terminalId: 'a',
    });
    expect(written).toEqual([
      [
        '/w/repo/.shellie/brain-answer-3.md',
        answerFileText('What\nwas decided?', 'Semicolons.'),
      ],
    ]);
    expect(typed).toEqual([
      [
        'a',
        'Read .shellie/brain-answer-3.md: what the project\'s brain says about "What was decided?"',
      ],
    ]);
    expect(typed[0][1]).not.toMatch(/[\r\n]/);
  });

  it('writes and types nothing when no tab can take it', async () => {
    for (const reason of ['none', 'busy', 'typing'] as const) {
      const { d, written, typed } = deps({ reason });
      expect(await sendAnswer(d, 'Q', 'A')).toEqual({ ok: false, reason });
      expect(written).toEqual([]);
      expect(typed).toEqual([]);
    }
  });

  it('holds the question and the answer in the file', () => {
    expect(answerFileText('Why?', 'Because.\n')).toBe(
      "# What the project's brain says\n\n## Question\n\nWhy?\n\n## Answer\n\nBecause.\n",
    );
  });

  it('cuts a long question in the typed line at 120 characters', () => {
    const line = answerLine('.shellie/brain-answer-1.md', 'x'.repeat(300));
    expect(line).toBe(
      `Read .shellie/brain-answer-1.md: what the project's brain says about "${'x'.repeat(120)}…"`,
    );
  });
});
