import { describe, expect, it } from 'vitest';
import type { BrainConflictRow } from '../../../../shared/brain';
import { defaultQuestion } from './words';

const row = (b: { page: string; source: string | null }): BrainConflictRow => ({
  id: 'c',
  kind: 'scope-change',
  page: 'wiki/scope.md',
  detail: 'd',
  at: 'now',
  conflict: {
    id: 'c',
    question: 'Is CRM in?',
    claims: {
      a: {
        page: 'wiki/scope.md',
        quote: 'CRM is out.',
        source: 'sources/sow.md',
        date: '2026-10-28',
      },
      b: {
        page: b.page,
        quote: 'Add CRM.',
        source: b.source,
        date: '2026-11-10',
      },
    },
    suggestion: null,
    reopens: null,
  },
});
const titleOf = (p: string) =>
  p === 'wiki/scope.md'
    ? 'Scope'
    : p.replace(/^sources\//, '').replace(/\.md$/, '');

describe('defaultQuestion', () => {
  it('names the source a claim cites, but not twice when the claim is the source itself', () => {
    expect(
      defaultQuestion(
        row({ page: 'sources/steerco.md', source: 'sources/steerco.md' }),
        titleOf,
      ),
    ).toBe(
      'Is CRM in? Scope (sow.md, 2026-10-28) says "CRM is out."; steerco (2026-11-10) says "Add CRM.". Which is current?',
    );
  });
});
