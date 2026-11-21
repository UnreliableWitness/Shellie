import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExitError } from '../services/prSummary';
import {
  abortable,
  DreamFailed,
  runReason,
  sessionOf,
  settledWithin,
  taskRef,
} from './dreamRun';

afterEach(() => vi.useRealTimers());

const never = () => new Promise<string>(() => undefined);

describe('abortable', () => {
  it('passes the result through, and rejects at once on abort', async () => {
    const ac = new AbortController();
    expect(await abortable(Promise.resolve('x'), ac.signal)).toBe('x');
    const p = abortable(never(), ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow('stopped');
  });
});

describe('settledWithin', () => {
  it('ends when the promise settles, or after the time when it does not', async () => {
    vi.useFakeTimers();
    let done = false;
    void settledWithin(Promise.reject(new Error('x')), 10_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    done = false;
    void settledWithin(never(), 10_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});

describe('runReason', () => {
  it('says missing, timed out or stopped, never the output', () => {
    const enoent = Object.assign(new Error('spawn opencode ENOENT'), {
      code: 'ENOENT',
    });
    expect(runReason(enoent, 1_800_000)).toBe(
      'OpenCode (opencode) was not found',
    );
    expect(runReason(new ExitError('x', 127, ''), 1_800_000)).toBe(
      'OpenCode (opencode) was not found',
    );
    expect(runReason(new Error('timed out after 1800 s'), 1_800_000)).toBe(
      'timed out after 30 min',
    );
    expect(
      runReason(new ExitError('secret session text', 1, 'secret'), 1_800_000),
    ).toBe('OpenCode stopped');
  });
});

describe('sessionOf', () => {
  const ev = (e: object) => JSON.stringify(e);
  it('reads the session of a run with or without answer text', () => {
    expect(
      sessionOf(
        [
          ev({ type: 'step_start', sessionID: 's1' }),
          ev({ type: 'text', sessionID: 's1', part: { text: 'hi' } }),
        ].join('\n'),
      ),
    ).toBe('s1');
    expect(sessionOf(ev({ type: 'step_start', sessionID: 's2' }))).toBe('s2');
    expect(sessionOf('profile noise')).toBeNull();
  });

  it('fails with a fixed reason on an error event', () => {
    const out = ev({
      type: 'error',
      sessionID: 's',
      error: { data: { message: 'secret' } },
    });
    expect(() => sessionOf(out)).toThrow(DreamFailed);
    try {
      sessionOf(out);
    } catch (e) {
      expect((e as DreamFailed).reason).toBe('OpenCode stopped');
    }
  });
});

describe('taskRef', () => {
  const tasks = [
    { taskId: 't1', label: 'Fix the login page' },
    { taskId: 't2', label: 'Login' },
  ];
  it('matches by id, digest file, label, closest label, else keeps the name', () => {
    expect(taskRef('t2', tasks)).toEqual({ taskId: 't2', label: 'Login' });
    expect(taskRef('tasks/t1.md', tasks).taskId).toBe('t1');
    expect(taskRef('LOGIN', tasks).taskId).toBe('t2');
    expect(taskRef('the login page', tasks).taskId).toBe('t1');
    expect(taskRef('unknown', tasks)).toEqual({
      taskId: 'unknown',
      label: 'unknown',
    });
    expect(taskRef('', tasks)).toEqual({ taskId: '', label: '' });
  });
});
