import { describe, expect, it } from 'vitest';
import {
  DIGEST_MAX,
  sessionDigest,
  sessionDigestFromTurns,
  sessionTurns,
  TURN_MAX,
} from './sessionDigest';

const user = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', message: { content: text }, ...extra });
const claude = (parts: unknown[]) =>
  JSON.stringify({ type: 'assistant', message: { content: parts } });

describe('sessionTurns', () => {
  it('keeps what the developer typed and what Claude said, not tools, meta or injected text', () => {
    const lines = [
      user('<system-reminder>ignored</system-reminder>'),
      user('Fix the login bug'),
      claude([
        { type: 'text', text: 'Looking at auth.ts.' },
        { type: 'tool_use', name: 'Read', input: {} },
      ]),
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: 'file contents' }],
        },
      }),
      claude([{ type: 'text', text: 'The token expiry was off by one.' }]),
      user('meta', { isMeta: true }),
      user('side', { isSidechain: true }),
      user('[Request interrupted by user]'),
      'not json',
      user('Great, ship it'),
    ];
    expect(sessionTurns(lines)).toEqual([
      { who: 'Developer', text: 'Fix the login bug' },
      {
        who: 'Claude',
        text: 'Looking at auth.ts.\nThe token expiry was off by one.',
      },
      { who: 'Developer', text: 'Great, ship it' },
    ]);
  });
});

describe('sessionDigest', () => {
  it('writes a markdown digest per session, cut per turn and in total', () => {
    const a = [user('First question'), claude([{ type: 'text', text: 'A' }])];
    const b = [user('x'.repeat(TURN_MAX + 50))];
    const d = sessionDigest('Login bug', [a, b])!;
    expect(
      d.startsWith('# Session of task: Login bug\n\n## Session 1\n\n'),
    ).toBe(true);
    expect(d).toContain('**Developer:** First question\n');
    expect(d).toContain('**Claude:** A\n');
    expect(d).toContain('## Session 2');
    expect(d).toContain(`${'x'.repeat(TURN_MAX - 1)}…`);
    const many = Array.from({ length: 200 }, () => user('y'.repeat(1000)));
    const big = sessionDigest('T', [many])!;
    expect(big.length).toBeLessThanOrEqual(DIGEST_MAX + 100);
    expect(big.endsWith('_(cut: the sessions were longer)_\n')).toBe(true);
  });

  it('is null when nobody typed anything', () => {
    expect(sessionDigest('T', [])).toBeNull();
    expect(
      sessionDigest('T', [[claude([{ type: 'text', text: 'hello' }])]]),
    ).toBeNull();
    const single = sessionDigest('T', [[user('only one')]])!;
    expect(single).not.toContain('## Session');
  });
});

describe('after review', () => {
  it('drops the compaction summary and numbers only the sessions with content', () => {
    const compact = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      message: {
        content:
          'This session is being continued from a previous conversation…',
      },
    });
    expect(sessionTurns([compact, user('real')])).toEqual([
      { who: 'Developer', text: 'real' },
    ]);
    const toolsOnly = [claude([{ type: 'text', text: 'only me' }])];
    const d = sessionDigest('T', [
      toolsOnly,
      [user('one')],
      toolsOnly,
      [user('two')],
    ])!;
    expect(d).toContain('## Session 1\n\n**Developer:** one');
    expect(d).toContain('## Session 2\n\n**Developer:** two');
    expect(d).not.toContain('## Session 3');
    expect(sessionDigest('T', [toolsOnly, [user('one')]])).not.toContain(
      '## Session',
    );
  });
});

describe('sessionDigestFromTurns', () => {
  it("writes OpenCode's turns with the Agent speaker, after Claude's", () => {
    const d = sessionDigestFromTurns('T', [
      sessionTurns([user('to claude'), claude([{ type: 'text', text: 'C' }])]),
      [
        { who: 'Developer', text: 'to opencode' },
        { who: 'Agent', text: 'O' },
      ],
      [{ who: 'Agent', text: 'nobody typed' }],
    ])!;
    expect(d).toContain('## Session 1\n\n**Developer:** to claude\n');
    expect(d).toContain('**Claude:** C\n');
    expect(d).toContain('## Session 2\n\n**Developer:** to opencode\n');
    expect(d).toContain('**Agent:** O\n');
    expect(d).not.toContain('## Session 3');
    expect(sessionDigestFromTurns('T', [])).toBeNull();
  });
});
