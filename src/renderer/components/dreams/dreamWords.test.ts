import { describe, expect, it } from 'vitest';
import {
  journalLine,
  navLine,
  nowLine,
  repoStateLine,
  stepLine,
  usageText,
  waitLine,
  whenWords,
} from './dreamWords';
import {
  emptyState,
  journalEntry,
  MODEL,
  result,
  settings,
  viewOf,
} from '../../test-helpers/dreamFixtures';

const NOW = new Date('2026-11-20T15:00:00').getTime();

describe('whenWords', () => {
  it.each([
    ['2026-11-20T03:12:00', 'today 03:12'],
    ['2026-11-19T22:40:00', 'yesterday 22:40'],
    ['2026-11-18T13:05:00', 'Wed 13:05'],
    ['2026-11-14T08:00:00', 'Sat 08:00'],
    ['2026-11-13T08:00:00', '13 Nov'],
    ['2026-10-12T08:00:00', '12 Oct'],
  ])('%s', (iso, words) => expect(whenWords(iso, NOW)).toBe(words));
  it('keeps text that is not a date', () =>
    expect(whenWords('soon', NOW)).toBe('soon'));
});

describe('journalLine', () => {
  const j = journalEntry;
  it.each([
    [j(), '2 proposals, waiting for you'],
    [j({ proposals: 1 }), '1 proposal, waiting for you'],
    [
      j({ removedByCheck: 1 }),
      '2 proposals, waiting for you · 1 more removed by its own check',
    ],
    [j({ outcome: 'nothing', proposals: 0 }), 'Nothing to propose'],
    [
      j({
        proposals: 3,
        closed: { as: 'task', kept: 2, dropped: 1, taskName: 'Dream 18 Nov' },
      }),
      '3 proposals · 2 kept, opened as task “Dream 18 Nov” · 1 dropped',
    ],
    [
      j({
        proposals: 2,
        closed: { as: 'task', kept: 2, dropped: 0, taskName: null },
      }),
      '2 proposals · 2 kept, opened as a task',
    ],
    [
      j({
        proposals: 3,
        closed: { as: 'discarded', kept: 0, dropped: 3, taskName: null },
      }),
      '3 proposals · discarded',
    ],
    [
      j({ outcome: 'interrupted', reason: 'stopped' }),
      'Stopped: you pressed Stop',
    ],
    [j({ outcome: 'limit', reason: 'limit' }), "Stopped at today's limit"],
    [
      j({ outcome: 'interrupted', reason: 'suspend' }),
      'Stopped: the machine went to sleep',
    ],
    [
      j({ outcome: 'failed', reason: 'OpenCode stopped' }),
      'Failed: OpenCode stopped',
    ],
    [
      j({ outcome: 'wrong-model', reason: 'answered by x/y' }),
      'Thrown away: answered by another model',
    ],
  ])('%#', (entry, line) => expect(journalLine(entry)).toBe(line));
});

describe('nowLine and waitLine', () => {
  const v = viewOf();
  it('names a running dream with its minutes', () => {
    const running = {
      repoId: 'r2',
      startedAt: NOW - 4.5 * 60_000,
      step: 'reading' as const,
    };
    expect(nowLine(viewOf({ running, waiting: null }), NOW)).toBe(
      'Dreaming about billing, 4 min',
    );
  });
  it.each([
    ['active', 'Waiting until you are away'],
    ['agents-busy', 'Waiting: an agent is working'],
    ['battery', 'Waiting for mains power'],
    ['limit', "Today's limit reached"],
    ['model-missing', `${MODEL} is not available in OpenCode`],
    ['nothing-ready', 'Nothing new to dream about'],
  ] as const)('%s', (waiting, line) => {
    expect(nowLine(viewOf({ waiting }), NOW)).toBe(line);
    expect(waitLine(waiting, MODEL)).toBe(line);
  });
  it('never says nothing before the first check', () =>
    expect(nowLine(viewOf({ waiting: null }), NOW)).not.toBe(''));
  it('is a function of the view', () => expect(nowLine(v, NOW)).toBeTruthy());
});

describe('repoStateLine', () => {
  const at = (r: number, patch: Parameters<typeof emptyState>[0], n = 0) => {
    const v = viewOf();
    v.repos[r].state = emptyState(patch);
    v.repos[r].newSessions = n;
    return repoStateLine(v.repos[r], v, NOW);
  };
  it('waits for a review', () =>
    expect(at(0, { result: result('a', 'r1', ['x']) }, 3)).toBe(
      "3 new sessions wait until you have reviewed today's dream",
    ));
  it('says 1 new session waits', () =>
    expect(at(0, { result: result('a', 'r1', ['x']) }, 1)).toBe(
      "1 new session waits until you have reviewed today's dream",
    ));
  it('counts new sessions', () => expect(at(0, {}, 4)).toBe('4 new sessions'));
  it('says since when nothing is new', () =>
    expect(at(0, { lastDreamAt: '2026-11-19T22:40:00' })).toBe(
      'Nothing new since yesterday 22:40',
    ));
  it('says why it keeps failing', () =>
    expect(at(0, { failures: 2, lastFailure: 'OpenCode stopped' })).toBe(
      'Keeps failing: OpenCode stopped',
    ));
  it('says an off repo is never read', () =>
    expect(at(2, {})).toBe('Its sessions are never read'));
  it('says so for every repo while dreaming is off', () => {
    const v = viewOf({ settings: settings({ enabled: false }) });
    expect(repoStateLine(v.repos[0], v, NOW)).toBe(
      'Its sessions are never read',
    );
  });
});

describe('navLine', () => {
  it('off', () =>
    expect(navLine(viewOf({ settings: settings({ enabled: false }) }))).toEqual(
      { line: 'Dreams off', model: '', tone: 'quiet' },
    ));
  it('on', () =>
    expect(navLine(viewOf())).toEqual({
      line: 'Dreams on',
      model: MODEL,
      tone: 'quiet',
    }));
  it('running', () =>
    expect(
      navLine(
        viewOf({
          running: { repoId: 'r2', startedAt: NOW - 240_000, step: 'reading' },
        }),
        NOW,
      ),
    ).toEqual({
      line: 'Dreaming about billing',
      model: `${MODEL} · 4 min`,
      tone: 'active',
    }));
  it('on with no limit', () =>
    expect(
      navLine(viewOf({ settings: settings({ limit: { kind: 'none' } }) })),
    ).toEqual({ line: 'Dreams on · no limit', model: MODEL, tone: 'warn' }));
});

describe('usageText', () => {
  const usage = (
    tokens: number,
    eur: number | null,
    limit = settings().limit,
  ) =>
    usageText(
      viewOf({
        usage: { day: 'd', tokens, eur },
        settings: settings({ limit }),
      }),
    );
  it('tokens in millions when both are large', () =>
    expect(usage(1_200_000, 0)).toEqual({
      text: '1.2 of 5 million tokens',
      percent: 24,
    }));
  it('spaced whole numbers when one is small', () =>
    expect(usage(90_000, 0, { kind: 'tokens', perDay: 500_000 })).toEqual({
      text: '90 000 of 500 000 tokens',
      percent: 18,
    }));
  it('euros', () =>
    expect(usage(0, 0.4, { kind: 'eur', perDay: 2 })).toEqual({
      text: '€ 0.40 of € 2.00',
      percent: 20,
    }));
  it('an unmeasurable spend has no bar', () =>
    expect(usage(0, null, { kind: 'eur', perDay: 2 }).percent).toBeNull());
  it('no limit, no bar', () =>
    expect(usage(1_200_000, 0, { kind: 'none' })).toEqual({
      text: '1.2 million tokens · no limit',
      percent: null,
    }));
  it('caps the bar at 100', () =>
    expect(usage(9_000_000, 0).percent).toBe(100));
});

describe('stepLine', () => {
  it('reads', () => expect(stepLine('reading', 4)).toBe('Reading 4 sessions'));
  it('omits an unknown count', () =>
    expect(stepLine('reading', null)).toBe('Reading sessions'));
  it('checks', () =>
    expect(stepLine('checking', 4)).toBe('Checking its own proposals'));
});
