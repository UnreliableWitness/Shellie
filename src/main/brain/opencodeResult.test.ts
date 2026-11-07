import { describe, expect, it } from 'vitest';
import { opencodeResultWithSession } from './opencodeResult';

const line = (o: unknown) => JSON.stringify(o);
const start = (id = 'ses_1') =>
  line({ type: 'step_start', sessionID: id, part: { type: 'step-start' } });
const text = (t: string, id = 'ses_1') =>
  line({ type: 'text', sessionID: id, part: { type: 'text', text: t } });
const finish = (id = 'ses_1') =>
  line({
    type: 'step_finish',
    sessionID: id,
    part: { type: 'step-finish', tokens: {}, cost: 0 },
  });
const tool = line({
  type: 'tool_use',
  sessionID: 'ses_1',
  part: { type: 'tool', tool: 'skill', state: { status: 'completed' } },
});

describe('opencodeResultWithSession', () => {
  it('takes the text of the last step and the session id', () => {
    const out = [
      start(),
      tool,
      text('thinking'),
      finish(),
      start(),
      text('DONE'),
      finish(),
    ].join('\n');
    expect(opencodeResultWithSession(out)).toEqual({
      result: 'DONE',
      sessionId: 'ses_1',
    });
  });

  it('joins several text parts of the last step', () => {
    const out = [start(), text('one'), text('two'), finish()].join('\n');
    expect(opencodeResultWithSession(out).result).toBe('one\ntwo');
  });

  it('ignores earlier steps when the last step has text', () => {
    const out = [
      start(),
      text('early'),
      finish(),
      start(),
      text('late'),
      finish(),
    ].join('\n');
    expect(opencodeResultWithSession(out).result).toBe('late');
  });

  it('skips a line that is not JSON', () => {
    const out = [start(), 'warning: something', text('DONE'), finish()].join(
      '\n',
    );
    expect(opencodeResultWithSession(out).result).toBe('DONE');
  });

  it('throws when nothing was printed', () => {
    expect(() => opencodeResultWithSession('  \n')).toThrow(
      'OpenCode printed nothing',
    );
  });

  it('falls back to the newest earlier text when the last step has none', () => {
    const out = [
      start(),
      text('first'),
      finish(),
      start(),
      text('one'),
      text('two'),
      finish(),
      start(),
      tool,
      finish(),
    ].join('\n');
    expect(opencodeResultWithSession(out).result).toBe('one\ntwo');
  });

  it('throws when there is no text part', () => {
    expect(() =>
      opencodeResultWithSession([start(), tool, finish()].join('\n')),
    ).toThrow('OpenCode gave no result');
  });

  it('throws with the message of an error line', () => {
    const err = line({
      type: 'error',
      timestamp: 1794085536989,
      sessionID: 'ses_e482b3ec6ffeqYNSDvGZDfaqGm',
      error: {
        name: 'UnknownError',
        data: {
          message: 'Unexpected server error. Check server logs for details.',
          ref: 'err_a9e8849e',
        },
      },
    });
    expect(() => opencodeResultWithSession(err)).toThrow(
      'OpenCode stopped (Unexpected server error. Check server logs for details.)',
    );
    const boom = line({
      type: 'error',
      error: { name: 'UnknownError', data: { message: 'boom' } },
    });
    expect(() => opencodeResultWithSession([start(), boom].join('\n'))).toThrow(
      'OpenCode stopped (boom)',
    );
  });
});
