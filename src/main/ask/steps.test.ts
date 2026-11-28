import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AskProgress, AskStep } from '../../shared/askProgress';
import {
  claudeEvent,
  claudeStreamResult,
  isClaudeResultLine,
  opencodeStep,
  progressLog,
} from './steps';

const cwd = path.resolve('/work/brain');
const inCwd = (rel: string) => path.join(cwd, rel);

const oc = (tool: string, input: unknown, status = 'completed') =>
  JSON.stringify({
    type: 'tool_use',
    sessionID: 's1',
    part: { type: 'tool', tool, state: { status, input } },
  });
const claudeTool = (name: string, input: unknown) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
  });
const claudeText = (text: string) =>
  JSON.stringify({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  });

describe('opencodeStep', () => {
  it('names a read, an edit and a write by the path in the folder', () => {
    expect(
      opencodeStep(oc('read', { filePath: inCwd('wiki/a.md') }), cwd),
    ).toEqual({ kind: 'read', label: 'Read wiki/a.md' });
    expect(
      opencodeStep(oc('edit', { filePath: inCwd('rules/b.md') }), cwd),
    ).toEqual({ kind: 'edit', label: 'Edited rules/b.md' });
    expect(opencodeStep(oc('write', { filePath: 'new.md' }), cwd)).toEqual({
      kind: 'write',
      label: 'Wrote new.md',
    });
  });

  it('names a search by its pattern, cut at 60 characters', () => {
    expect(opencodeStep(oc('grep', { pattern: 'retry' }), cwd)).toEqual({
      kind: 'search',
      label: 'Searched for “retry”',
    });
    expect(opencodeStep(oc('glob', { pattern: '**/*.md' }), cwd)).toEqual({
      kind: 'search',
      label: 'Looked for **/*.md',
    });
    const long = opencodeStep(oc('grep', { pattern: 'x'.repeat(200) }), cwd);
    expect(long?.label).toBe(`Searched for “${'x'.repeat(59)}…”`);
  });

  it('never shows a path outside the folder', () => {
    for (const filePath of ['/etc/passwd', '../secret.md', inCwd('../x.md')])
      expect(opencodeStep(oc('read', { filePath }), cwd)).toEqual({
        kind: 'read',
        label: 'Read a file outside the folder',
      });
  });

  it('names any other tool plainly, and is nothing for what is not a finished tool call', () => {
    expect(opencodeStep(oc('todowrite', {}), cwd)).toEqual({
      kind: 'other',
      label: 'Used todowrite',
    });
    expect(opencodeStep(oc('weird tool\n<b>', {}), cwd)).toEqual({
      kind: 'other',
      label: 'Used a tool',
    });
    expect(opencodeStep(oc('read', { filePath: 'a.md' }, 'running'), cwd)).toBe(
      null,
    );
    expect(opencodeStep('{"type":"text","part":{"text":"hi"}}', cwd)).toBe(
      null,
    );
    expect(opencodeStep('not json', cwd)).toBe(null);
    expect(opencodeStep('null', cwd)).toBe(null);
  });
});

describe('claudeEvent', () => {
  it('gives a step for a tool call, and says the text so far is not the answer', () => {
    expect(
      claudeEvent(claudeTool('Read', { file_path: inCwd('wiki/a.md') }), cwd),
    ).toEqual({ step: { kind: 'read', label: 'Read wiki/a.md' }, reset: true });
    expect(claudeEvent(claudeTool('Grep', { pattern: 'ships' }), cwd)).toEqual({
      step: { kind: 'search', label: 'Searched for “ships”' },
      reset: true,
    });
    expect(claudeEvent(claudeTool('Glob', { pattern: '*.md' }), cwd)).toEqual({
      step: { kind: 'search', label: 'Looked for *.md' },
      reset: true,
    });
  });

  it('gives the text of a text delta, and nothing for thinking or anything else', () => {
    expect(claudeEvent(claudeText('The release'), cwd)).toEqual({
      text: 'The release',
    });
    expect(
      claudeEvent(
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'hm' },
          },
        }),
        cwd,
      ),
    ).toBe(null);
    expect(claudeEvent('{"type":"system","subtype":"init"}', cwd)).toBe(null);
    expect(claudeEvent('bash: profile noise', cwd)).toBe(null);
  });
});

describe('claudeStreamResult', () => {
  const result = (over: object = {}) =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'At noon.',
      session_id: 's9',
      ...over,
    });
  it('reads the answer and the session from the result line', () => {
    const out = ['profile noise', claudeText('At'), result(), ''].join('\n');
    expect(claudeStreamResult(out)).toEqual({
      result: 'At noon.',
      sessionId: 's9',
    });
  });
  it('knows the result line whatever the order of its keys', () => {
    expect(isClaudeResultLine(result())).toBe(true);
    expect(
      isClaudeResultLine('{"duration_ms":4928,"result":"x","type":"result"}'),
    ).toBe(true);
    expect(isClaudeResultLine(claudeText('"type":"result"'))).toBe(false);
    expect(isClaudeResultLine('not json "type":"result"')).toBe(false);
  });
  it('fails as a single JSON result does', () => {
    expect(() => claudeStreamResult(claudeText('At'))).toThrow(
      'Claude Code gave no result',
    );
    expect(() =>
      claudeStreamResult(result({ subtype: 'error_max_turns', result: '' })),
    ).toThrow('Claude Code stopped (error_max_turns)');
    expect(() => claudeStreamResult('')).toThrow('Claude Code printed nothing');
  });
});

describe('progressLog', () => {
  const step = (n: number): AskStep => ({ kind: 'read', label: `Read ${n}` });
  it('keeps the newest forty steps and counts the rest', () => {
    const log = progressLog(() => undefined);
    for (let i = 1; i <= 45; i++) log.step(step(i));
    const p = log.snapshot();
    expect(p.steps).toHaveLength(40);
    expect(p.steps[0]).toEqual(step(6));
    expect(p.earlier).toBe(5);
  });
  it('takes a step that repeats the last one once', () => {
    const log = progressLog(() => undefined);
    log.step(step(1));
    log.step(step(1));
    log.step(step(2));
    log.step(step(1));
    expect(log.snapshot().steps).toEqual([step(1), step(2), step(1)]);
  });
  it('adds text up, and forgets it on a reset', () => {
    const log = progressLog(() => undefined);
    log.text('Let me ');
    log.text('look.');
    expect(log.snapshot().text).toBe('Let me look.');
    log.resetText();
    log.text('At noon.');
    expect(log.snapshot().text).toBe('At noon.');
  });
  it('says so at once, then at most once per interval, the last state always', () => {
    vi.useFakeTimers();
    try {
      const seen: AskProgress[] = [];
      const log = progressLog((p) => seen.push(p), { everyMs: 250 });
      for (let i = 0; i < 10; i++) log.text('a');
      expect(seen.map((p) => p.text)).toEqual(['a']);
      vi.advanceTimersByTime(250);
      expect(seen.map((p) => p.text)).toEqual(['a', 'a'.repeat(10)]);
      vi.advanceTimersByTime(1000);
      expect(seen).toHaveLength(2);
      log.text('b');
      log.flush();
      expect(seen.at(-1)?.text).toBe(`${'a'.repeat(10)}b`);
      vi.advanceTimersByTime(1000);
      expect(seen).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
