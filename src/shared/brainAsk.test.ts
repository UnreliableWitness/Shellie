import { describe, expect, it } from 'vitest';
import { askWithContext, citedPaths, linkCited } from './brainAsk';

describe('askWithContext', () => {
  it('adds the work item on one line', () => {
    expect(
      askWithContext(' Who\nknows? ', {
        workItemId: '412',
        title: 'Export invoices as CSV',
      }),
    ).toBe(
      'Who knows? (Asked from the task for work item 412: Export invoices as CSV.)',
    );
  });

  it('names the task when there is no work item', () => {
    expect(askWithContext('Why?', { workItemId: null, title: 'spike' })).toBe(
      'Why? (Asked from the task "spike".)',
    );
  });
});

describe('citedPaths', () => {
  it('finds cited paths once, in order, without anchors', () => {
    expect(
      citedPaths(
        'See wiki/a.md and `sources/2026-11-04-deck.md#slide-4`.\nSources:\n- wiki/a.md\n- wiki/sub/b.md',
      ),
    ).toEqual(['wiki/a.md', 'sources/2026-11-04-deck.md', 'wiki/sub/b.md']);
  });

  it('ignores paths that leave the brain or are not pages or sources', () => {
    expect(
      citedPaths(
        '../wiki/a.md /etc/passwd wiki/../../x.md brain/state.json index.md',
      ),
    ).toEqual([]);
  });

  it('finds none in an answer without paths', () => {
    expect(citedPaths('The brain does not answer this.')).toEqual([]);
  });
});

describe('linkCited', () => {
  const has = (p: string) => p === 'wiki/a.md' || p === 'sources/d.md';

  it('turns the paths that exist into links, with their anchor, backticked or bare', () => {
    expect(
      linkCited('See `wiki/a.md` and sources/d.md#slide-4.\n- wiki/a.md', has),
    ).toBe(
      'See [wiki/a.md](wiki/a.md) and [sources/d.md#slide-4](sources/d.md#slide-4).\n- [wiki/a.md](wiki/a.md)',
    );
  });

  it('leaves a path that does not exist, leaves the brain or is already a link', () => {
    const text =
      'No `wiki/gone.md`, no wiki/../a.md, no ../wiki/a.md, and [the page](wiki/a.md).';
    expect(linkCited(text, has)).toBe(text);
  });

  it('leaves a link the agent wrote with the path as its text, and paths in a code block', () => {
    const linked = 'See [wiki/a.md](wiki/a.md) and [wiki/a.md]( wiki/a.md ).';
    expect(linkCited(linked, has)).toBe(linked);
    const fenced =
      'Before wiki/a.md\n\n```\ncat wiki/a.md\n```\n\nAfter `wiki/a.md`';
    expect(linkCited(fenced, has)).toBe(
      'Before [wiki/a.md](wiki/a.md)\n\n```\ncat wiki/a.md\n```\n\nAfter [wiki/a.md](wiki/a.md)',
    );
  });
});
