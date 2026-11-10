import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conflictIdOf,
  conflictOf,
  type BrainFinding,
  type SettleDecision,
} from '../../shared/brain';
import {
  EMPTY_CONFLICTS,
  listConflicts,
  readConflicts,
  updateConflicts,
  type ConflictsFile,
} from './conflicts';

const conflict = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  question: 'When does Acme go live?',
  claims: {
    a: {
      page: 'wiki/plan.md',
      quote: 'Go-live is 12 January',
      source: 'sources/sow.md',
      date: '2026-10-28',
    },
    b: {
      page: 'wiki/steerco.md',
      quote: 'Go-live moves to 2 February',
      source: null,
      date: null,
    },
  },
  suggestion: { pick: 'b', reason: 'newer' },
  ...over,
});
const finding = (
  over: Partial<BrainFinding> & { conflict?: unknown } = {},
): BrainFinding => ({
  kind: 'contradiction',
  page: 'wiki/plan.md',
  detail: 'go-live differs',
  at: '2026-11-10T08:00:00.000Z',
  ...over,
});
const decision = (
  id: string,
  over: Partial<SettleDecision> = {},
): SettleDecision => ({
  id,
  kind: 'contradiction',
  page: 'wiki/plan.md',
  question: 'When does Acme go live?',
  detail: 'go-live differs',
  claims: null,
  choice: 'b',
  text: null,
  why: null,
  answer: null,
  ...over,
});
const NOW = new Date('2026-11-10T12:00:00.000Z');

describe('conflictOf and conflictIdOf', () => {
  it("reads lint's conflict, with defaults for what it left out", () => {
    const c = conflictOf(finding({ conflict: conflict('c1') }));
    expect(c?.id).toBe('c1');
    expect(c?.claims.b.source).toBeNull();
    expect(c?.reopens).toBeNull();
    expect(
      conflictOf(
        finding({ conflict: conflict('c1', { suggestion: undefined }) }),
      )?.suggestion,
    ).toBeNull();
  });
  it('is null for a partial or missing conflict', () => {
    expect(
      conflictOf(finding({ conflict: { id: 'x', question: 'q' } })),
    ).toBeNull();
    expect(conflictOf(finding())).toBeNull();
  });
  it('names a finding by its conflict id, else by kind, page and detail', () => {
    expect(conflictIdOf(finding({ conflict: conflict('c1') }))).toBe('c1');
    expect(conflictIdOf(finding())).toBe(
      'contradiction:wiki/plan.md:go-live differs',
    );
  });
});

describe('listConflicts', () => {
  const file = (conflicts: ConflictsFile['conflicts']): ConflictsFile => ({
    version: 1,
    conflicts,
  });

  it('lists only contradictions and scope changes, newest first', () => {
    const r = listConflicts(
      [
        finding({ conflict: conflict('old'), at: '2026-11-09T08:00:00.000Z' }),
        finding({
          kind: 'scope-change',
          page: 'wiki/scope-x.md',
          conflict: conflict('new'),
          at: '2026-11-10T08:00:00.000Z',
        }),
        finding({ kind: 'stale', page: 'wiki/s.md' }),
      ],
      EMPTY_CONFLICTS,
      NOW,
    );
    expect(r.open.map((o) => o.id)).toEqual(['new', 'old']);
    expect(r.open[0].kind).toBe('scope-change');
    expect(r.open[0].conflict?.question).toBe('When does Acme go live?');
  });

  it('hides a settled conflict unless lint reopened it, and lists parked ones apart', () => {
    const r = listConflicts(
      [
        finding({ conflict: conflict('settled') }),
        finding({
          conflict: conflict('back', {
            reopens: 'wiki/decision-2026-11-01-x.md',
          }),
        }),
        finding({ conflict: conflict('parked') }),
      ],
      file({
        settled: {
          settled: {
            at: '2026-11-10T09:00:00.000Z',
            status: 'done',
            decision: decision('settled'),
            page: null,
            error: null,
          },
        },
        back: {
          settled: {
            at: '2026-11-01T09:00:00.000Z',
            status: 'done',
            decision: decision('back'),
            page: null,
            error: null,
          },
        },
        parked: {
          parked: { question: 'Which is it?', at: '2026-11-10T10:00:00.000Z' },
        },
      }),
      NOW,
    );
    expect(r.open.map((o) => o.id)).toEqual(['back']);
    expect(r.parked).toEqual([
      expect.objectContaining({
        id: 'parked',
        question: 'Which is it?',
        parkedAt: '2026-11-10T10:00:00.000Z',
      }),
    ]);
  });

  it('carries an answer given for a conflict on its open row, as an answer in flight', () => {
    const r = listConflicts(
      [finding({ conflict: conflict('c1') })],
      file({
        c1: {
          answered: {
            path: 'sources/answer.md',
            text: 'Yes',
            at: '2026-11-10T10:00:00.000Z',
          },
        },
      }),
      NOW,
    );
    expect(r.open[0]).toMatchObject({
      id: 'c1',
      answer: { path: 'sources/answer.md', text: 'Yes' },
    });
    expect(r.answers).toEqual(['sources/answer.md']);
  });

  it('keeps failed and pending settles listed however old, so Retry stays', () => {
    const r = listConflicts(
      [],
      file({
        f: {
          settled: {
            at: '2026-08-01T09:00:00.000Z',
            status: 'failed',
            decision: decision('f'),
            page: null,
            error: 'x',
          },
        },
      }),
      NOW,
    );
    expect(r.settled.map((s) => s.id)).toEqual(['f']);
  });

  it('lists settles of the last 30 days with their state, and the answers of pending or failed ones', () => {
    const r = listConflicts(
      [],
      file({
        a: {
          settled: {
            at: '2026-11-10T09:00:00.000Z',
            status: 'pending',
            decision: decision('a', { answer: 'sources/answer-a.md' }),
            page: null,
            error: null,
          },
        },
        b: {
          settled: {
            at: '2026-11-09T09:00:00.000Z',
            status: 'failed',
            decision: decision('b', {
              answer: 'sources/answer-b.md',
              choice: 'neither',
              text: '1 March',
            }),
            page: null,
            error: 'boom',
          },
        },
        c: {
          settled: {
            at: '2026-11-08T09:00:00.000Z',
            status: 'done',
            decision: decision('c', { answer: 'sources/answer-c.md' }),
            page: 'wiki/decision-c.md',
            error: null,
          },
        },
        old: {
          settled: {
            at: '2026-09-01T09:00:00.000Z',
            status: 'done',
            decision: decision('old'),
            page: null,
            error: null,
          },
        },
      }),
      NOW,
    );
    expect(r.settled.map((s) => [s.id, s.status])).toEqual([
      ['a', 'pending'],
      ['b', 'failed'],
      ['c', 'done'],
    ]);
    expect(r.settled[1]).toMatchObject({
      choice: 'neither',
      text: '1 March',
      error: 'boom',
    });
    expect(r.answers.sort()).toEqual([
      'sources/answer-a.md',
      'sources/answer-b.md',
    ]);
  });
});

describe('conflicts.json', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'brain-conflicts-'));
    await mkdir(path.join(dir, 'brain'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('reads a missing or broken file as empty', async () => {
    expect(await readConflicts(dir)).toEqual(EMPTY_CONFLICTS);
    await writeFile(path.join(dir, 'brain', 'conflicts.json'), '{nope');
    expect(await readConflicts(dir)).toEqual(EMPTY_CONFLICTS);
  });

  it('keeps both of two updates made at once', async () => {
    await Promise.all([
      updateConflicts(dir, (f) => ({
        ...f,
        conflicts: {
          ...f.conflicts,
          a: { parked: { question: 'q', at: 't' } },
        },
      })),
      updateConflicts(dir, (f) => ({
        ...f,
        conflicts: {
          ...f.conflicts,
          b: { parked: { question: 'r', at: 't' } },
        },
      })),
    ]);
    expect(Object.keys((await readConflicts(dir)).conflicts).sort()).toEqual([
      'a',
      'b',
    ]);
  });
});
