import { describe, expect, it } from 'vitest';
import type { BrainBook, BrainState } from '../../../shared/brain';
import type { Members, SharedFacts } from '../../../shared/brainShare';
import type { ConflictsFile } from '../conflicts';
import {
  mergeBook,
  mergeConflicts,
  mergeKeyedMap,
  mergeLog,
  mergeMembers,
  mergeShared,
  mergeState,
} from './jsonMerge';

const state = (o: Partial<BrainState> = {}): BrainState => ({
  schemaVersion: 1,
  lastSyncCommit: null,
  lastLintAt: null,
  captured: {},
  findings: [],
  ...o,
});

describe('mergeLog', () => {
  const head = '# Log\n\n';
  it('keeps both sides new entries, newest first, without duplicates', () => {
    const base = `${head}- 2026-11-01T10:00:00.000Z old\n`;
    const ours = `${head}- 2026-11-03T10:00:00.000Z ours\n- 2026-11-01T10:00:00.000Z old\n`;
    const theirs = `${head}- 2026-11-04T10:00:00.000Z theirs\n- 2026-11-01T10:00:00.000Z old\n`;
    expect(mergeLog(base, ours, theirs)).toBe(
      `${head}- 2026-11-04T10:00:00.000Z theirs\n- 2026-11-03T10:00:00.000Z ours\n- 2026-11-01T10:00:00.000Z old\n`,
    );
  });
  it('merges ## blocks with their body lines', () => {
    const ours = '# Log\n\n## 2026-11-02 a\nbody a\n';
    const theirs = '# Log\n\n## 2026-11-03 b\nbody b\n';
    expect(mergeLog(null, ours, theirs)).toBe(
      '# Log\n\n## 2026-11-03 b\nbody b\n## 2026-11-02 a\nbody a\n',
    );
  });
  it('without dates keeps ours first, then theirs only', () => {
    const ours = '# Log\n\n- x\n- y\n';
    const theirs = '# Log\n\n- z\n- y\n';
    expect(mergeLog(null, ours, theirs)).toBe('# Log\n\n- x\n- y\n- z\n');
  });
});

describe('mergeState', () => {
  const never = () => false;
  it('keeps the later capture of a source', () => {
    const a = state({ captured: { s: { at: '2026-11-01', sessionId: 'a' } } });
    const b = state({
      captured: {
        s: { at: '2026-11-02', sessionId: 'b' },
        t: { at: '2026-11-01', sessionId: null },
      },
    });
    const m = mergeState(null, a, b, never);
    expect(m.captured.s.sessionId).toBe('b');
    expect(Object.keys(m.captured).sort()).toEqual(['s', 't']);
    expect(mergeState(null, b, a, never).captured.s.sessionId).toBe('b');
  });
  it('takes findings and lastLintAt from the later lint', () => {
    const f = (page: string) => ({
      kind: 'stale' as const,
      page,
      detail: '',
      at: '',
    });
    const a = state({ lastLintAt: '2026-11-02', findings: [f('a')] });
    const b = state({ lastLintAt: '2026-11-03', findings: [f('b')] });
    const m = mergeState(null, a, b, never);
    expect(m.lastLintAt).toBe('2026-11-03');
    expect(m.findings[0].page).toBe('b');
    expect(mergeState(null, b, a, never).findings[0].page).toBe('b');
  });
  it('takes the descendant commit, else the base one', () => {
    const a = state({ lastSyncCommit: 'A' });
    const b = state({ lastSyncCommit: 'B' });
    const base = state({ lastSyncCommit: 'BASE' });
    expect(
      mergeState(base, a, b, (x, y) => x === 'A' && y === 'B').lastSyncCommit,
    ).toBe('B');
    expect(
      mergeState(base, a, b, (x, y) => x === 'B' && y === 'A').lastSyncCommit,
    ).toBe('A');
    expect(mergeState(base, a, b, never).lastSyncCommit).toBe('BASE');
    expect(mergeState(null, a, b, never).lastSyncCommit).toBeNull();
  });
});

describe('mergeConflicts', () => {
  const decision = {
    question: 'q',
    choice: 'keep',
    text: null,
  } as unknown as NonNullable<
    ConflictsFile['conflicts'][string]['settled']
  >['decision'];
  const settled = {
    at: '2026-11-02',
    status: 'done' as const,
    decision,
    page: null,
    error: null,
  };
  it('settled on one side and parked on the other ends settled', () => {
    const ours: ConflictsFile = {
      version: 1,
      conflicts: { c1: { settled } },
    };
    const theirs: ConflictsFile = {
      version: 1,
      conflicts: { c1: { parked: { question: 'q', at: '2026-11-01' } } },
    };
    for (const m of [
      mergeConflicts(ours, theirs),
      mergeConflicts(theirs, ours),
    ]) {
      expect(m.conflicts.c1.settled).toEqual(settled);
      expect(m.conflicts.c1.parked).toBeUndefined();
    }
  });
  it('parked beats open, later answer wins, ids are unioned', () => {
    const ours: ConflictsFile = {
      version: 1,
      conflicts: {
        c1: { answered: { path: 'a', text: 'old', at: '2026-11-01' } },
        c2: { parked: { question: 'q', at: '2026-11-01' } },
      },
    };
    const theirs: ConflictsFile = {
      version: 1,
      conflicts: {
        c1: {
          parked: { question: 'q2', at: '2026-11-02' },
          answered: { path: 'b', text: 'new', at: '2026-11-02' },
        },
      },
    };
    const m = mergeConflicts(ours, theirs);
    expect(m.conflicts.c1.parked?.question).toBe('q2');
    expect(m.conflicts.c1.answered?.text).toBe('new');
    expect(m.conflicts.c2.parked).toBeDefined();
  });
});

describe('mergeKeyedMap', () => {
  it('unions and lets the later at win', () => {
    const m = mergeKeyedMap(
      { a: { at: '2026-11-02', v: 1 }, b: { at: '1', v: 1 } },
      { a: { at: '2026-11-01', v: 2 }, c: { at: '1', v: 3 } },
    );
    expect(m.a.v).toBe(1);
    expect(Object.keys(m).sort()).toEqual(['a', 'b', 'c']);
  });
  it('theirs wins without at', () => {
    expect(
      mergeKeyedMap<{ at?: string; v: number }>(
        { a: { v: 1 } },
        { a: { v: 2 } },
      ).a,
    ).toEqual({ v: 2 });
  });
});

describe('mergeBook', () => {
  it('keeps theirs order and appends pages and chapters only in ours', () => {
    const ch = (title: string, pages: string[]) => ({
      title,
      summary: '',
      intro: '',
      pages,
    });
    const ours: BrainBook = {
      chapters: [ch('B', ['b1', 'b2']), ch('A', ['a1', 'a9']), ch('C', ['c1'])],
    };
    const theirs: BrainBook = {
      chapters: [ch('A', ['a2', 'a1']), ch('B', ['b1'])],
    };
    const m = mergeBook(ours, theirs);
    expect(m.chapters.map((c) => [c.title, c.pages])).toEqual([
      ['A', ['a2', 'a1', 'a9']],
      ['B', ['b1', 'b2']],
      ['C', ['c1']],
    ]);
  });
});

describe('mergeShared', () => {
  const facts = (at: string, n: number, wikiAt: string): SharedFacts => ({
    format: 1,
    wiki: null,
    lastRefreshAt: null,
    lastDigestAt: null,
    templatesVersion: n,
    updatedAt: {
      wiki: wikiAt,
      lastRefreshAt: at,
      lastDigestAt: at,
      templatesVersion: at,
    },
  });
  it('per field the later updatedAt wins', () => {
    const ours = { ...facts('2026-11-02', 5, '1'), lastDigestAt: 'ours' };
    const m = mergeShared(ours, facts('2026-11-01', 5, '2'));
    expect(m.lastDigestAt).toBe('ours');
    expect(m.updatedAt.lastDigestAt).toBe('2026-11-02');
    expect(m.updatedAt.wiki).toBe('2');
  });
  it('keeps the higher skills version whatever its updatedAt', () => {
    expect(
      mergeShared(facts('2026-11-02', 5, '1'), facts('2026-11-01', 9, '2'))
        .templatesVersion,
    ).toBe(9);
    const m = mergeShared(
      facts('2026-11-01', 9, '1'),
      facts('2026-11-02', 5, '2'),
    );
    expect(m.templatesVersion).toBe(9);
    expect(m.updatedAt.templatesVersion).toBe('2026-11-01');
  });
});

describe('mergeMembers', () => {
  it('unions by installId and keeps the earlier joinedAt', () => {
    const m = (list: Members['members']): Members => ({
      format: 1,
      members: list,
    });
    const r = mergeMembers(
      m([{ installId: 'a', name: 'A', joinedAt: '2026-11-02' }]),
      m([
        { installId: 'a', name: 'A2', joinedAt: '2026-11-01' },
        { installId: 'b', name: 'B', joinedAt: '2026-11-03' },
      ]),
    );
    expect(r.members).toEqual([
      { installId: 'a', name: 'A2', joinedAt: '2026-11-01' },
      { installId: 'b', name: 'B', joinedAt: '2026-11-03' },
    ]);
  });
});
