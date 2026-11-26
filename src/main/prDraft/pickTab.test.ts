import { describe, expect, it } from 'vitest';
import {
  pickSendTab,
  pickTab,
  RECENT_MS,
  sendVerdict,
  type TabCandidate,
} from './pickTab';

const NOW = 10 * RECENT_MS;
const tab = (o: Partial<TabCandidate> & { id: string }): TabCandidate => ({
  label: o.id,
  kind: 'claude',
  running: true,
  paused: false,
  lastAgentTurnAt: NOW - 60_000,
  activity: {
    state: 'done',
    typed: false,
    quietFor: 60_000,
  },
  ...o,
});
const act = (o: Partial<NonNullable<TabCandidate['activity']>>) => ({
  state: 'done' as const,
  typed: false,
  quietFor: 60_000,
  ...o,
});

describe('pickTab', () => {
  it('asks an idle, quiet, recently used tab', () => {
    expect(pickTab([tab({ id: 'a' })], NOW)).toEqual({
      tab: expect.objectContaining({ id: 'a' }),
    });
    expect(
      pickTab([tab({ id: 'a', activity: act({ state: 'idle' }) })], NOW),
    ).toHaveProperty('tab');
  });

  it('asks a resumed tab that reported nothing since it started', () => {
    expect(
      pickTab(
        [
          tab({
            id: 'a',
            kind: 'opencode',
            activity: act({ state: null }),
          }),
        ],
        NOW,
      ),
    ).toHaveProperty('tab');
  });

  it('picks the most recently active of several', () => {
    const r = pickTab(
      [
        tab({ id: 'old', lastAgentTurnAt: NOW - 600_000 }),
        tab({ id: 'new', lastAgentTurnAt: NOW - 1000 }),
      ],
      NOW,
    );
    expect(r).toEqual({ tab: expect.objectContaining({ id: 'new' }) });
  });

  it('never types over unsent text', () => {
    expect(
      pickTab([tab({ id: 'a', activity: act({ typed: true }) })], NOW),
    ).toEqual({ reason: 'typing' });
  });

  it('never types into a working, blocked or exited agent, or one still printing', () => {
    for (const state of ['working', 'blocked', 'clear'] as const)
      expect(
        pickTab([tab({ id: 'a', activity: act({ state }) })], NOW),
      ).toEqual({ reason: 'busy' });
    expect(
      pickTab([tab({ id: 'a', activity: act({ quietFor: 500 }) })], NOW),
    ).toEqual({ reason: 'busy' });
    expect(pickTab([tab({ id: 'a', activity: null })], NOW)).toEqual({
      reason: 'busy',
    });
  });

  it('skips a tab not used in the last hour', () => {
    expect(
      pickTab([tab({ id: 'a', lastAgentTurnAt: NOW - RECENT_MS - 1 })], NOW),
    ).toEqual({ reason: 'stale' });
  });

  it('has no tab when none runs, is paused or has turns', () => {
    expect(pickTab([], NOW)).toEqual({ reason: 'no-tab' });
    expect(
      pickTab(
        [
          tab({ id: 'a', running: false }),
          tab({ id: 'b', paused: true }),
          tab({ id: 'c', lastAgentTurnAt: null }),
        ],
        NOW,
      ),
    ).toEqual({ reason: 'no-tab' });
  });

  it('gives the reason that explains the most', () => {
    expect(
      pickTab(
        [
          tab({ id: 's', lastAgentTurnAt: 0 }),
          tab({ id: 'b', activity: act({ state: 'working' }) }),
          tab({ id: 't', activity: act({ typed: true }) }),
        ],
        NOW,
      ),
    ).toEqual({ reason: 'typing' });
    expect(
      pickTab(
        [
          tab({ id: 's', lastAgentTurnAt: 0 }),
          tab({ id: 'b', activity: act({ state: 'working' }) }),
        ],
        NOW,
      ),
    ).toEqual({ reason: 'busy' });
  });
});

describe('sendVerdict and pickSendTab', () => {
  it('never types into a paused tab or one that does not run', () => {
    expect(sendVerdict(tab({ id: 'a', paused: true }), NOW)).toBe('none');
    expect(sendVerdict(tab({ id: 'a', running: false }), NOW)).toBe('none');
  });

  it('takes an idle, quiet tab whatever its age, and one without a turn yet', () => {
    expect(
      sendVerdict(tab({ id: 'a', lastAgentTurnAt: NOW - 2 * RECENT_MS }), NOW),
    ).toBe('ok');
    expect(sendVerdict(tab({ id: 'a', lastAgentTurnAt: null }), NOW)).toBe(
      'ok',
    );
  });

  it('refuses a tab with unsent text, a working agent or fresh output', () => {
    expect(
      sendVerdict(tab({ id: 'a', activity: act({ typed: true }) }), NOW),
    ).toBe('typing');
    expect(
      sendVerdict(tab({ id: 'a', activity: act({ state: 'working' }) }), NOW),
    ).toBe('busy');
    expect(
      sendVerdict(tab({ id: 'a', activity: act({ quietFor: 100 }) }), NOW),
    ).toBe('busy');
    expect(sendVerdict(tab({ id: 'a', activity: null }), NOW)).toBe('busy');
  });

  it('picks the tab with the latest agent turn; one without turns is oldest', () => {
    const picked = pickSendTab(
      [
        tab({ id: 'none', lastAgentTurnAt: null }),
        tab({ id: 'old', lastAgentTurnAt: NOW - 5000 }),
        tab({ id: 'new', lastAgentTurnAt: NOW - 1000 }),
        tab({
          id: 'busy',
          lastAgentTurnAt: NOW,
          activity: act({ state: 'working' }),
        }),
      ],
      NOW,
    );
    expect(picked).toEqual({ tab: expect.objectContaining({ id: 'new' }) });
  });

  it('says why no tab can take it: unsent text, then busy, then none', () => {
    const typing = tab({ id: 't', activity: act({ typed: true }) });
    const busy = tab({ id: 'b', activity: act({ state: 'working' }) });
    const paused = tab({ id: 'p', paused: true });
    expect(pickSendTab([paused, busy, typing], NOW)).toEqual({
      reason: 'typing',
    });
    expect(pickSendTab([paused, busy], NOW)).toEqual({ reason: 'busy' });
    expect(pickSendTab([paused], NOW)).toEqual({ reason: 'none' });
    expect(pickSendTab([], NOW)).toEqual({ reason: 'none' });
  });
});
