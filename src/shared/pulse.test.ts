import { describe, expect, it } from 'vitest';
import { taskSignal, type PrPulse } from './pulse';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const H = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function pulse(over: Partial<PrPulse> = {}): PrPulse {
  return {
    workspaceId: 'a',
    pr: {
      id: 1,
      url: 'u',
      status: 'active',
      isDraft: false,
      createdAt: iso(NOW - 3 * H),
      closedAt: null,
    },
    ci: 'passing',
    ciFailedName: null,
    review: 'waiting',
    approvals: { have: 0, need: null },
    conflict: false,
    unanswered: 0,
    checkedAt: iso(NOW),
    ...over,
  };
}
const withPr = (
  over: Partial<NonNullable<PrPulse['pr']>>,
  rest: Partial<PrPulse> = {},
): PrPulse => pulse({ pr: { ...pulse().pr!, ...over }, ...rest });
describe('taskSignal', () => {
  const sig = (pulses: PrPulse[], agentBlocked = false) =>
    taskSignal({ pulses, agentBlocked, now: NOW });
  const merged = (ws: string) =>
    withPr(
      { status: 'completed', closedAt: iso(NOW - H) },
      { workspaceId: ws },
    );

  it('is merged when every live PR is completed', () => {
    expect(sig([merged('a')])).toEqual({
      state: 'merged',
      story: 'PR merged',
      prWorkspaceId: null,
    });
  });
  it('is merged beside an abandoned PR or a workspace without one', () => {
    expect(
      sig([
        merged('a'),
        withPr({ status: 'abandoned' }, { workspaceId: 'b' }),
        pulse({ workspaceId: 'c', pr: null }),
      ]).state,
    ).toBe('merged');
  });
  it('is not merged while another PR is active', () => {
    expect(sig([merged('a'), pulse({ workspaceId: 'b' })]).state).toBe('none');
  });
  it.each([
    [{ ci: 'failing' as const }],
    [{ conflict: true }],
    [{ review: 'changes-asked' as const }],
    [{ unanswered: 2 }],
  ])('waits on PR trouble %j and names its workspace', (over) => {
    const s = sig([pulse({ workspaceId: 'w', ...over })]);
    expect(s.state).toBe('waits');
    expect(s.prWorkspaceId).toBe('w');
    expect(s.story).not.toBe('');
  });
  it('names the worse of two troubled workspaces', () => {
    const s = sig([
      pulse({ workspaceId: 'a', unanswered: 1 }),
      pulse({ workspaceId: 'b', ci: 'failing', ciFailedName: 'build' }),
    ]);
    expect(s.prWorkspaceId).toBe('b');
    expect(s.story).toContain('CI failing: build');
  });
  it('names the older PR when two have the same trouble', () => {
    const s = sig([
      withPr(
        { createdAt: iso(NOW - 2 * H) },
        { workspaceId: 'a', conflict: true },
      ),
      withPr(
        { createdAt: iso(NOW - 9 * H) },
        { workspaceId: 'b', conflict: true },
      ),
    ]);
    expect(s.prWorkspaceId).toBe('b');
  });
  it('waits on a blocked agent, with no PR to open', () => {
    const s = sig([pulse()], true);
    expect(s.state).toBe('waits');
    expect(s.prWorkspaceId).toBeNull();
    expect(s.story).toContain('agent needs you');
  });
  it('waits on a blocked agent without any pulse', () => {
    expect(sig([], true)).toEqual({
      state: 'waits',
      story: 'agent needs you',
      prWorkspaceId: null,
    });
  });
  it('is none for a healthy published PR, and still tells its story', () => {
    const s = sig([
      withPr(
        { createdAt: iso(NOW - 48 * H) },
        { approvals: { have: 1, need: 2 } },
      ),
    ]);
    expect(s).toEqual({
      state: 'none',
      story: '1 of 2 approvals · waiting 2d',
      prWorkspaceId: null,
    });
  });
  it('is none and silent without pulses', () => {
    expect(sig([])).toEqual({ state: 'none', story: '', prWorkspaceId: null });
  });
  it('is not merged with only abandoned PRs', () => {
    expect(sig([withPr({ status: 'abandoned' })])).toEqual({
      state: 'none',
      story: '',
      prWorkspaceId: null,
    });
  });
  it('tells the whole story of a troubled PR', () => {
    expect(
      sig([
        withPr(
          { createdAt: iso(NOW - 30 * H) },
          {
            ci: 'failing',
            ciFailedName: 'PR build',
            approvals: { have: 1, need: 2 },
            unanswered: 2,
          },
        ),
      ]).story,
    ).toBe(
      'CI failing: PR build · 1 of 2 approvals · 2 unanswered comments · waiting 1d',
    );
  });
  it('survives a missing createdAt without NaN', () => {
    expect(sig([withPr({ createdAt: '' })]).story).not.toMatch(/NaN/);
    expect(
      sig([withPr({ createdAt: '' }, { ci: 'failing' })]).story,
    ).not.toMatch(/NaN/);
  });
  it('waits on a blocked agent even when the PR is merged', () => {
    expect(sig([merged('a')], true)).toEqual({
      state: 'waits',
      story: 'agent needs you',
      prWorkspaceId: null,
    });
  });
  it('is none for a draft PR', () => {
    expect(sig([withPr({ isDraft: true })]).state).toBe('none');
  });
});
