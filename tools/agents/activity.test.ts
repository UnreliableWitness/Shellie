import { describe, expect, it } from 'vitest';
import * as activityModule from './activity.mjs';
import {
  canRunAgent,
  emptyActivity,
  recordPause,
  recordRun,
  renderActivity,
} from './activity.mjs';
import { parseStatus } from './state.mjs';

const at = (iso: string) => new Date(iso);

describe('activity', () => {
  it('stops agent runs while paused and resumes after', () => {
    const a = recordPause(emptyActivity(), at('2026-10-26T10:00:00Z'), 60);
    expect(a.pausedUntil).toBe('2026-10-26T11:00:00.000Z');
    expect(canRunAgent(a, at('2026-10-26T10:59:00Z'), 20)).toEqual({
      ok: false,
      reason: 'paused',
    });
    expect(canRunAgent(a, at('2026-10-26T11:00:00Z'), 20).ok).toBe(true);
  });
  it('caps runs per UTC day', () => {
    let a = emptyActivity();
    for (let i = 0; i < 20; i++) a = recordRun(a, at('2026-10-26T10:00:00Z'));
    expect(canRunAgent(a, at('2026-10-26T23:00:00Z'), 20)).toEqual({
      ok: false,
      reason: 'daily-cap',
    });
    expect(canRunAgent(a, at('2026-10-27T00:01:00Z'), 20).ok).toBe(true);
  });
  it('keeps a week of run counts', () => {
    let a = recordRun(emptyActivity(), at('2026-10-01T10:00:00Z'));
    a = recordRun(a, at('2026-10-26T10:00:00Z'));
    expect(Object.keys(a.runsByDay)).toEqual(['2026-10-26']);
  });
  it('renders a readable body with the block', () => {
    const a = recordRun(emptyActivity(), at('2026-10-26T10:00:00Z'));
    const body = renderActivity(
      a,
      { 'agent:ready': 2 },
      at('2026-10-26T10:00:00Z'),
      20,
    );
    expect(body).toContain('Agent runs today: 1 of 20');
    expect(body).toContain('agent:ready');
    expect(parseStatus(body)).toEqual(a);
  });
});

describe('mergeActivity', () => {
  it('sums run counts per day and keeps the latest pause', () => {
    const { mergeActivity } = activityModule;
    const m = mergeActivity([
      {
        v: 1,
        runsByDay: { '2026-10-26': 3, '2026-10-25': 1 },
        shadowSeen: {},
        pausedUntil: '2026-10-26T10:00:00.000Z',
      },
      {
        v: 1,
        poller: 'implement',
        runsByDay: { '2026-10-26': 2 },
        shadowSeen: {},
        pausedUntil: '2026-10-26T12:00:00.000Z',
      },
      { v: 1, poller: 'review', runsByDay: {}, shadowSeen: {} },
    ]);
    expect(m.runsByDay).toEqual({ '2026-10-26': 5, '2026-10-25': 1 });
    expect(m.pausedUntil).toBe('2026-10-26T12:00:00.000Z');
  });
});
