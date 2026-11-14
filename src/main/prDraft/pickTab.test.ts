import { describe, expect, it } from 'vitest';
import { pickTab, RECENT_MS, type TabCandidate } from './pickTab';

const NOW = 10 * RECENT_MS;
const tab = (o: Partial<TabCandidate> & { id: string }): TabCandidate => ({
  label: o.id,
  kind: 'claude',
  running: true,
  paused: false,
  lastAgentTurnAt: NOW - 60_000,
  activity: {
    state: 'done',
    stateAt: NOW - 60_000,
    typed: false,
    quietFor: 60_000,
  },
  ...o,
});
const act = (o: Partial<NonNullable<TabCandidate['activity']>>) => ({
  state: 'done' as const,
  stateAt: NOW,
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
            activity: act({ state: null, stateAt: null }),
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
