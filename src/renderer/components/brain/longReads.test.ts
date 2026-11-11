import { beforeEach, describe, expect, it } from 'vitest';
import type { BrainJob, BrainReads } from '../../../shared/brain';
import { brainJob } from '../../test-helpers/brainFixture';
import {
  bodyOf,
  isRead,
  loadMarks,
  newestLetter,
  openTopics,
  saveMarks,
  splitLetter,
  splitRead,
  unreadCount,
  writeJob,
  writeLabel,
} from './longReads';

const ESSAY = [
  'An order is a promise, see [Orders](../wiki/subject-orders.md).',
  '',
  '## The first step',
  '',
  'A clerk keys it in [as the deck says][deck].',
  '',
  '> **Before you read on**',
  '> Why is the credit check before stock is reserved?',
  '>',
  '> **Answer**',
  '> Reserved stock is hard to release, see [Scope](../wiki/scope.md).',
  '',
  'After the check the order is released.',
  '',
  '[deck]: ../sources/2026-10-09-kickoff.md#p3',
  '',
  '## What the writer was missing',
  '',
  '- Why the limit is 5000.',
  '',
].join('\n');

describe('bodyOf', () => {
  it('drops the frontmatter and the title heading the reader shows already', () => {
    expect(bodyOf('---\r\ntitle: T\r\n---\r\n\r\n# T\r\n\r\nFirst.\r\n')).toBe(
      '\nFirst.\n',
    );
    expect(bodyOf('No frontmatter.\n')).toBe('No frontmatter.\n');
  });
});

describe('splitRead', () => {
  it('cuts the essay at its question and sets the missing section apart', () => {
    const { parts, missing } = splitRead(ESSAY);
    expect(parts.map((p) => p.kind)).toEqual(['prose', 'question', 'prose']);
    expect(parts[1]).toEqual({
      kind: 'question',
      question: 'Why is the credit check before stock is reserved?',
      answer:
        'Reserved stock is hard to release, see [Scope](../wiki/scope.md).',
    });
    expect(missing).toBe('- Why the limit is 5000.');
  });

  it('gives each part the link definitions it does not hold itself', () => {
    const { parts } = splitRead(ESSAY);
    const def = '[deck]: ../sources/2026-10-09-kickoff.md#p3';
    expect((parts[0] as { text: string }).text).toContain(def);
    expect((parts[2] as { text: string }).text.split(def)).toHaveLength(2);
  });

  it('keeps a block without an answer, and any other quote, as prose', () => {
    const body =
      'Before.\n\n> **Before you read on**\n> A question?\n\n> A quote.\n\nAfter.\n';
    const { parts, missing } = splitRead(body);
    expect(parts).toEqual([{ kind: 'prose', text: body.trim() }]);
    expect(missing).toBeNull();
  });

  it('leaves what a code block quotes alone: its marker and its heading are an example', () => {
    const fenced = [
      'The template looks like this:',
      '',
      '```md',
      '> **Before you read on**',
      '> A question?',
      '>',
      '> **Answer**',
      '> An answer.',
      '',
      '## What the writer was missing',
      '```',
      '',
      'And the essay goes on.',
      '',
      '## What the writer was missing',
      '',
      '- The real gap.',
    ].join('\n');
    const { parts, missing } = splitRead(fenced);
    expect(parts.map((p) => p.kind)).toEqual(['prose']);
    expect((parts[0] as { text: string }).text).toContain(
      'And the essay goes on.',
    );
    expect(missing).toBe('- The real gap.');
  });

  it('an essay without a question is one part', () => {
    expect(splitRead('Just prose.\n').parts).toEqual([
      { kind: 'prose', text: 'Just prose.' },
    ]);
    expect(splitRead('').parts).toEqual([]);
  });
});

describe('splitLetter', () => {
  it('reads one change as four labelled sections after the opening', () => {
    const l = splitLetter(
      [
        'The credit check moved.',
        '',
        '## What you read',
        'The check came first.',
        '',
        '## What holds now',
        'Stock is reserved first, see [Decision](../../wiki/decision-x.md).',
        '',
        '## Why it changed',
        'The sources do not say why.',
        '',
        '## What follows',
        'Ask about released stock.',
      ].join('\n'),
    );
    expect(l.opening).toBe('The credit check moved.');
    expect(l.changes).toHaveLength(1);
    expect(l.changes[0].title).toBeNull();
    expect(l.changes[0].sections.map((s) => [s.kind, s.label])).toEqual([
      ['read', 'What you read'],
      ['now', 'What holds now'],
      ['why', 'Why it changed'],
      ['follows', 'What follows'],
    ]);
    expect(l.changes[0].sections[0].text).toBe('The check came first.');
  });

  it('reads several changes, each with its own sections', () => {
    const l = splitLetter(
      [
        'Two things changed.',
        '## The credit limit',
        'In short.',
        '### What you read',
        '5000.',
        '### What holds now',
        '8000.',
        '## Returns',
        '### What you read',
        'Inspect first.',
        '#### A detail',
        'Kept in the section.',
      ].join('\n'),
    );
    expect(l.changes.map((c) => c.title)).toEqual([
      'The credit limit',
      'Returns',
    ]);
    expect(l.changes[0].intro).toBe('In short.');
    expect(l.changes[0].sections.map((s) => s.text)).toEqual([
      '5000.',
      '8000.',
    ]);
    expect(l.changes[1].sections[0].text).toBe(
      'Inspect first.\n#### A detail\nKept in the section.',
    );
  });

  it('keeps a heading inside a code block in the section it is quoted in', () => {
    const { changes } = splitLetter(
      [
        'Opening.',
        '',
        '## What you read',
        '',
        '~~~',
        '## What holds now',
        '~~~',
        '',
        '## What holds now',
        '',
        'Now.',
      ].join('\n'),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].sections.map((s) => s.kind)).toEqual(['read', 'now']);
    expect(changes[0].sections[0].text).toContain('## What holds now');
  });

  it('a body without the four sections is shown as written', () => {
    expect(splitLetter('Hello.\n\n## Something else\nText.\n')).toEqual({
      opening: 'Hello.\n\n## Something else\nText.',
      changes: [],
    });
  });
});

describe('read marks', () => {
  beforeEach(() => localStorage.clear());

  const reads: BrainReads = {
    reads: [
      {
        path: 'reads/a.md',
        title: 'A',
        summary: '',
        chapter: 'Orders',
        topic: null,
        written: '2026-11-09',
        minutes: 7,
        hash: 'h1',
        stale: [],
      },
    ],
    letters: [
      {
        path: 'reads/letters/2026-11-10-a.md',
        title: 'Newer',
        read: 'reads/a.md',
        written: '2026-11-10',
        minutes: 2,
        hash: 'l2',
      },
      {
        path: 'reads/letters/2026-11-09-a.md',
        title: 'Older',
        read: 'reads/a.md',
        written: '2026-11-09',
        minutes: 2,
        hash: 'l1',
      },
    ],
  };

  it('are kept per brain, and a mark is for one text', () => {
    saveMarks('b1', {
      'reads/a.md': { hash: 'h1', at: '2026-11-11T09:00:00Z' },
    });
    expect(loadMarks('b2')).toEqual({});
    const marks = loadMarks('b1');
    expect(isRead(marks, reads.reads[0])).toBe(true);
    expect(isRead(marks, { ...reads.reads[0], hash: 'h2' })).toBe(false);
    expect(unreadCount(reads, marks)).toBe(2);
    expect(unreadCount(reads, {})).toBe(3);
  });

  it('a stored value that is not marks counts as none', () => {
    localStorage.setItem('shellie.brain.reads.b1', '[1]');
    expect(loadMarks('b1')).toEqual({});
    localStorage.setItem('shellie.brain.reads.b1', '{"reads/a.md":{"hash":1}}');
    expect(loadMarks('b1')).toEqual({});
    localStorage.setItem('shellie.brain.reads.b1', 'not json');
    expect(loadMarks('b1')).toEqual({});
  });

  it('the newest letter about a long read is the first one listed', () => {
    expect(newestLetter(reads, 'reads/a.md')?.title).toBe('Newer');
    expect(newestLetter(reads, 'reads/b.md')).toBeUndefined();
  });
});

describe('write jobs', () => {
  const job = (over: Partial<BrainJob>) =>
    brainJob({ kind: 'write', source: null, ...over });

  it('the newest job of a target says whether it is still to run', () => {
    const jobs = [
      job({ id: 'new', target: 'chapter:Orders', status: 'queued' }),
      job({ id: 'old', target: 'chapter:Orders', status: 'failed' }),
      job({ id: 'x', target: 'chapter:Returns', status: 'failed' }),
      job({ id: 'c', kind: 'capture', target: 'chapter:Stock' }),
    ];
    expect(writeJob(jobs, 'chapter:Orders')).toMatchObject({
      job: { id: 'new' },
      pending: true,
    });
    expect(writeJob(jobs, 'chapter:Returns')?.pending).toBe(false);
    expect(writeJob(jobs, 'chapter:Stock')).toBeNull();
  });

  it('lists the topics still being written or whose newest try failed', () => {
    const jobs = [
      job({ id: 'a', target: 'topic:Credit notes', status: 'running' }),
      job({ id: 'a0', target: 'topic:Credit notes', status: 'failed' }),
      job({ id: 'b', target: 'topic:Done', status: 'done' }),
      job({ id: 'b0', target: 'topic:Done', status: 'failed' }),
      job({ id: 'c', target: 'chapter:Orders', status: 'queued' }),
      job({ id: 'd', target: 'topic:Returns', status: 'failed' }),
    ];
    expect(openTopics(jobs).map((j) => j.id)).toEqual(['a', 'd']);
  });

  it('labels what a write job is for', () => {
    expect(writeLabel('chapter:Orders')).toBe('chapter Orders');
    expect(writeLabel('topic:Credit notes')).toBe('Credit notes');
    expect(writeLabel('reads/order-to-invoice.md')).toBe(
      'update of order-to-invoice.md',
    );
    expect(writeLabel('nonsense')).toBe('nonsense');
  });
});
