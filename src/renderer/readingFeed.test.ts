import { describe, expect, it } from 'vitest';
import { freshNudge, hasEvent, readingOf, workKey } from './readingFeed';
import {
  readingBrain,
  readingLetter,
  readingRead,
  readMark,
} from './test-helpers/readingFixture';

const work = [{ id: 412, title: 'Return flow' }];

describe('freshNudge', () => {
  it('says nothing about what was there at the first look', () => {
    const { seen, nudge } = freshNudge(null, [
      readingBrain({
        reads: [readingRead({ work })],
        letters: [readingLetter()],
        marks: {},
      }),
    ]);
    expect(nudge).toBeNull();
    expect(seen.size).toBeGreaterThan(0);
  });

  it('names a letter about something the reader read, once', () => {
    const before = [
      readingBrain({
        reads: [readingRead()],
        marks: { 'reads/returns.md': readMark('h1') },
      }),
    ];
    const after = [
      readingBrain({
        reads: [readingRead({ hash: 'h2' })],
        letters: [readingLetter()],
        marks: { 'reads/returns.md': readMark('h1') },
      }),
    ];
    const first = freshNudge(null, before);
    const second = freshNudge(first.seen, after);
    expect(second.nudge).toEqual({
      brainId: 'b1',
      path: 'reads/letters/2026-11-11-returns.md',
      title: 'The credit check moved',
      minutes: 2,
      piece: 'letter',
      kind: 'changed',
      about: 'How a return becomes a credit',
      more: 0,
    });
    expect(freshNudge(second.seen, after).nudge).toBeNull();
  });

  it('names a long read that changed without a letter', () => {
    const marks = { 'reads/returns.md': readMark('h1') };
    const first = freshNudge(null, [
      readingBrain({ reads: [readingRead()], marks }),
    ]);
    const { nudge } = freshNudge(first.seen, [
      readingBrain({ reads: [readingRead({ hash: 'h2' })], marks }),
    ]);
    expect(nudge).toMatchObject({
      path: 'reads/returns.md',
      piece: 'read',
      kind: 'changed',
    });
    expect(nudge).not.toHaveProperty('work');
  });

  it('names a newly written long read that bears on the work, and counts the others', () => {
    const first = freshNudge(null, [readingBrain()]);
    const { nudge } = freshNudge(first.seen, [
      readingBrain({
        reads: [
          readingRead({ work }),
          readingRead({ path: 'reads/orders.md', title: 'Orders', work }),
          readingRead({ path: 'reads/plain.md', title: 'No work' }),
        ],
      }),
    ]);
    expect(nudge).toMatchObject({
      path: 'reads/returns.md',
      kind: 'work',
      piece: 'read',
      work: work[0],
      more: 1,
    });
  });

  it('is silent for a long read that was there and only now bears on the work', () => {
    const first = freshNudge(null, [readingBrain({ reads: [readingRead()] })]);
    expect(
      freshNudge(first.seen, [readingBrain({ reads: [readingRead({ work })] })])
        .nudge,
    ).toBeNull();
  });

  it('is silent for a new long read with no work behind it', () => {
    const first = freshNudge(null, [readingBrain()]);
    expect(
      freshNudge(first.seen, [
        readingBrain({ reads: [readingRead({ chapter: 'Returns' })] }),
      ]).nudge,
    ).toBeNull();
  });
});

describe('hasEvent', () => {
  it('is for work and changes, not for unread foundations', () => {
    const pile = readingBrain({
      reads: [readingRead({ chapter: 'Returns' })],
    });
    expect(hasEvent(readingOf(pile))).toBe(false);
    expect(
      hasEvent(readingOf(readingBrain({ reads: [readingRead({ work })] }))),
    ).toBe(true);
    expect(
      hasEvent(
        readingOf(
          readingBrain({
            reads: [readingRead({ hash: 'h2' })],
            marks: { 'reads/returns.md': readMark('h1') },
          }),
        ),
      ),
    ).toBe(true);
  });
});

describe('workKey', () => {
  it('follows the work items of the open tasks only', () => {
    const tasks = [
      { status: 'ready', workItem: { id: '9' } },
      { status: 'done', workItem: { id: '3' } },
      { status: 'ready', workItem: null },
      { status: 'setting-up', workItem: { id: '12' } },
    ];
    expect(workKey(tasks)).toBe('12,9');
    expect(workKey([...tasks].reverse())).toBe('12,9');
  });
});
