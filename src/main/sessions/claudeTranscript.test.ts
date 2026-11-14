import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionTurns } from '../brain/sessionDigest';
import {
  LINE_MAX,
  TAIL_BYTES,
  lastAgentTurnAt,
  readClaudeTurns,
} from './claudeTranscript';

const at = (s: number) =>
  new Date(Date.UTC(2026, 10, 14, 10, 0, s)).toISOString();
const user = (text: string, ts = at(0), extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: { content: text },
    ...extra,
  });
const claude = (parts: unknown[], ts = at(1)) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { content: parts },
  });
const toolResult = (content: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(2),
    message: { content: [{ type: 'tool_result', tool_use_id: 'x', content }] },
  });

const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-transcript-'));
let n = 0;
const file = (lines: string[]) => {
  const f = path.join(dir, `t${++n}.jsonl`);
  writeFileSync(f, `${lines.join('\n')}\n`);
  return f;
};

afterEach(() => vi.restoreAllMocks());

describe('readClaudeTurns', () => {
  const lines = [
    user('<system-reminder>ignored</system-reminder>'),
    user('Fix the login bug', at(0)),
    claude(
      [
        { type: 'text', text: 'Looking at auth.ts.' },
        { type: 'tool_use', name: 'Read', input: {} },
      ],
      at(1),
    ),
    toolResult('file contents'),
    claude([{ type: 'text', text: 'The token expiry was off by one.' }], at(3)),
    user('meta', at(4), { isMeta: true }),
    'not json',
    user('Mention "type":"tool_result" in text', at(5)),
  ];

  it('gives the same turns as sessionTurns, with when each was said', async () => {
    const { turns } = await readClaudeTurns(file(lines));
    expect(turns.map(({ who, text }) => ({ who, text }))).toEqual(
      sessionTurns(lines),
    );
    expect(turns[0].at).toBe(Date.parse(at(0)));
    // Merged Claude texts carry the time of the last one.
    expect(turns[1].at).toBe(Date.parse(at(3)));
  });

  it('keeps a typed message that mentions a tool result', async () => {
    const { turns } = await readClaudeTurns(file(lines));
    expect(turns.at(-1)?.text).toContain('tool_result');
  });

  it('skips tool output and over-long lines without parsing them', async () => {
    const big = toolResult('x'.repeat(200_000));
    const long = user('y'.repeat(LINE_MAX + 1));
    const f = file([
      user('Hi'),
      big,
      long,
      claude([{ type: 'text', text: 'Hello' }]),
    ]);
    const parse = vi.spyOn(JSON, 'parse');
    const { turns } = await readClaudeTurns(f);
    expect(turns.map((t) => t.text)).toEqual(['Hi', 'Hello']);
    expect(
      parse.mock.calls.some(
        ([s]) => typeof s === 'string' && s.length > 150_000,
      ),
    ).toBe(false);
  });

  it('reads only what came after fromByte, and reports the size', async () => {
    const first = [user('First'), claude([{ type: 'text', text: 'One' }])];
    const f = file(first);
    const before = statSync(f).size;
    writeFileSync(
      f,
      `${[...first, user('Second'), claude([{ type: 'text', text: 'Two' }])].join('\n')}\n`,
    );
    const { turns, size } = await readClaudeTurns(f, { fromByte: before });
    expect(turns.map((t) => t.text)).toEqual(['Second', 'Two']);
    expect(size).toBe(statSync(f).size);
  });

  it('reads a missing file as no turns', async () => {
    expect(await readClaudeTurns(path.join(dir, 'nope.jsonl'))).toEqual({
      turns: [],
      size: 0,
    });
  });
});

describe('lastAgentTurnAt', () => {
  it('finds the last thing Claude said in the tail of a big file', async () => {
    const filler = Array.from({ length: 40 }, () =>
      toolResult('z'.repeat(20_000)),
    );
    const f = file([
      user('Start', at(0)),
      claude([{ type: 'text', text: 'Old' }], at(1)),
      ...filler,
      claude([{ type: 'text', text: 'Latest' }], at(9)),
      toolResult('after'),
    ]);
    expect(statSync(f).size).toBeGreaterThan(TAIL_BYTES);
    expect(await lastAgentTurnAt(f)).toBe(Date.parse(at(9)));
  });

  it('is null when Claude said nothing, or there is no file', async () => {
    expect(await lastAgentTurnAt(file([user('Only me')]))).toBeNull();
    expect(await lastAgentTurnAt(path.join(dir, 'nope.jsonl'))).toBeNull();
  });
});
