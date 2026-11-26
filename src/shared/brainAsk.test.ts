import { describe, expect, it } from 'vitest';
import { askWithContext, citedPaths } from './brainAsk';

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
