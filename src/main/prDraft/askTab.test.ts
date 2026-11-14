import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionState } from '../../shared/attention';
import type { Turn } from '../brain/sessionDigest';
import {
  askTab,
  POLL_MS,
  SETTLE_MS,
  SUBMIT_DELAY_MS,
  TAB_TIMEOUT_MS,
  type AskTabDeps,
} from './askTab';
import { PR_MARK_CLOSE, PR_MARK_OPEN, prRequestLine } from './protocol';

const line = prRequestLine('.shellie/pr-request-1.md');
const marked = (s: string) => `${PR_MARK_OPEN}\n${s}\n${PR_MARK_CLOSE}`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (o: Partial<AskTabDeps> = {}) => {
  let turns: Turn[] = [{ who: 'Developer', text: 'Earlier work' }];
  const listeners = new Set<(s: AttentionState) => void>();
  const log: string[] = [];
  let alive = true;
  const d: AskTabDeps = {
    line,
    writeRequest: async () => void log.push('write-request'),
    removeRequest: async () => void log.push('remove-request'),
    begin: async () => async () => turns,
    canType: () => true,
    type: (data) => void log.push(`type:${data}`),
    mute: () => void log.push('mute'),
    unmute: () => void log.push('unmute'),
    onState: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    alive: () => alive,
    onBlocked: (b) => void log.push(`blocked:${b}`),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    ...o,
  };
  return {
    d,
    log,
    say: (...t: Turn[]) => (turns = [...turns, ...t]),
    emit: (s: AttentionState) => [...listeners].forEach((l) => l(s)),
    kill: () => (alive = false),
  };
};

const started = async () => {
  await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
};

describe('askTab', () => {
  it('types the line, then Enter, muted, and returns the marked reply', async () => {
    const t = setup();
    const p = askTab(t.d, new AbortController().signal);
    await started();
    t.say(
      { who: 'Developer', text: line },
      { who: 'Claude', text: `Reading.\n${marked('## What changed\n- a')}` },
    );
    t.emit('done');
    await expect(p).resolves.toEqual({ text: '## What changed\n- a' });
    expect(t.log.slice(0, 4)).toEqual([
      'write-request',
      'mute',
      `type:${line}`,
      'type:\r',
    ]);
    expect(t.log).toContain('remove-request');
    expect(t.log).not.toContain('unmute');
  });

  it('keeps waiting when a turn ends before the request is in the session', async () => {
    const t = setup();
    const p = askTab(t.d, new AbortController().signal);
    await started();
    t.emit('idle');
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    t.say(
      { who: 'Developer', text: line },
      { who: 'Agent', text: marked('Text') },
    );
    t.emit('done');
    await expect(p).resolves.toEqual({ text: 'Text' });
  });

  it('gives up at once when the agent answered without the markers', async () => {
    const t = setup();
    const p = askTab(t.d, new AbortController().signal);
    await started();
    t.say(
      { who: 'Developer', text: line },
      { who: 'Claude', text: 'Which base branch?' },
    );
    t.emit('done');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await expect(p).resolves.toEqual({ reason: 'no-reply' });
  });

  it('reads once more when the reply lands just after the turn ended', async () => {
    const t = setup();
    const p = askTab(t.d, new AbortController().signal);
    await started();
    t.say(
      { who: 'Developer', text: line },
      { who: 'Claude', text: 'Reading.' },
    );
    t.emit('done');
    t.say({ who: 'Claude', text: marked('Late') });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    await expect(p).resolves.toEqual({ text: 'Late' });
  });

  it('does not judge an unfinished answer on a poll', async () => {
    const t = setup();
    const p = askTab(t.d, new AbortController().signal);
    await started();
    t.say(
      { who: 'Developer', text: line },
      { who: 'Claude', text: 'Reading the request.' },
    );
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    t.say({ who: 'Claude', text: marked('Done') });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await expect(p).resolves.toEqual({ text: 'Done' });
  });

  it('reports a permission prompt while it waits', async () => {
    const t = setup();
    const p = askTab(t.d, new AbortController().signal);
    await started();
    t.emit('blocked');
    t.emit('working');
    t.say(
      { who: 'Developer', text: line },
      { who: 'Claude', text: marked('X') },
    );
    t.emit('done');
    await p;
    expect(t.log).toContain('blocked:true');
    expect(t.log).toContain('blocked:false');
  });

  it('stops when the tab exits, or at the timeout, and unmutes', async () => {
    const a = setup();
    const pa = askTab(a.d, new AbortController().signal);
    await started();
    a.kill();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await expect(pa).resolves.toEqual({ reason: 'exited' });
    expect(a.log).toContain('unmute');

    const b = setup();
    const pb = askTab(b.d, new AbortController().signal);
    await started();
    await vi.advanceTimersByTimeAsync(TAB_TIMEOUT_MS);
    await expect(pb).resolves.toEqual({ reason: 'timeout' });
    expect(b.log).toContain('remove-request');
  });

  it('types nothing when typing became unsafe, or after an abort', async () => {
    const t = setup({ canType: () => false });
    await expect(askTab(t.d, new AbortController().signal)).resolves.toEqual({
      reason: 'busy',
    });
    expect(t.log.some((l) => l.startsWith('type:'))).toBe(false);
    expect(t.log).toContain('remove-request');

    const u = setup();
    const ac = new AbortController();
    const p = askTab(u.d, ac.signal);
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
    await expect(p).resolves.toEqual({ aborted: true });
    expect(u.log).not.toContain('type:\r');
    expect(u.log).toContain('unmute');
    expect(u.log).toContain('remove-request');
  });

  it('ignores the answer after Skip', async () => {
    const t = setup();
    const ac = new AbortController();
    const p = askTab(t.d, ac.signal);
    await started();
    ac.abort();
    t.say(
      { who: 'Developer', text: line },
      { who: 'Claude', text: marked('Late') },
    );
    t.emit('done');
    await expect(p).resolves.toEqual({ aborted: true });
  });
});
