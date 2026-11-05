import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BrainPageRow } from '../../../shared/brain';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { BrainWiki } from './BrainWiki';

const row = (over: Partial<BrainPageRow> & { path: string }): BrainPageRow => ({
  title: over.path,
  summary: '',
  type: 'other',
  lastUpdated: null,
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
  ...over,
});
const rows = [
  row({
    path: 'wiki/account.md',
    title: 'Acme',
    summary: 'Who they are.',
    type: 'account',
    confidence: 'high',
    verified: '2026-11-03',
    lastUpdated: '2026-11-02',
  }),
  row({
    path: 'wiki/scope-platform.md',
    title: 'Scope: platform',
    type: 'scope',
    confidence: 'low',
    verified: '2026-11-01',
    lastUpdated: '2026-11-03',
    changedSinceVerified: true,
  }),
  row({ path: 'wiki/digests/2026-w44.md', title: 'W44', type: 'digest' }),
  row({ path: 'wiki/digests/2026-w45.md', title: 'W45', type: 'digest' }),
  row({
    path: 'wiki/decision-2026-11-03-db.md',
    title: 'Database',
    type: 'decision',
    sources: ['sources/2026-11-01-kickoff.md'],
    linkedFrom: ['wiki/account.md'],
  }),
];
const pageText = (rel: string) =>
  rel === 'log.md'
    ? '# Log\n\n- 2026-11-04T10:00:00Z capture sources/2026-11-04-deck.md → pages: decision-2026-11-03-db; takeaway: x\n'
    : rel === 'sources/2026-11-01-kickoff.md'
      ? '---\ntitle: Kickoff\n---\n\n## p.2\n\nKickoff body.\n'
      : '---\ntitle: Database\n---\n\n# Database\n\nPostgres, see [kickoff](../sources/2026-11-01-kickoff.md#p2).\n';

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});

describe('BrainWiki', () => {
  it('shows pinned pages, recent entries, cards by type with tags, and opens a page with working links', async () => {
    const a = installFakeApi({
      'brain:pages': () => rows,
      'brain:sources': () => [
        {
          path: 'sources/2026-11-01-kickoff.md',
          type: 'deck',
          ingestedAt: '2026-11-01T09:00:00.000Z',
          captured: true,
          original: 'sources/2026-11-01-kickoff.pptx',
          contents: '12 slides',
          note: 'Kickoff deck; slide 7 pricing is outdated',
        },
      ],
      'brain:read': (_id, rel) => ({ text: pageText(rel) }),
    });
    render(<BrainWiki brainId="b1" />);
    const pinned = await screen.findByRole('region', { name: 'Pinned' });
    expect(
      within(pinned)
        .getAllByRole('button')
        .map((b) => b.title),
    ).toEqual([
      'wiki/account.md',
      'wiki/scope-platform.md',
      'wiki/digests/2026-w45.md',
    ]);
    expect(within(pinned).getByText('high')).toBeInTheDocument();
    expect(
      within(pinned).getByText('changed since verified'),
    ).toBeInTheDocument();
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(
      within(recent).getByRole('button', { name: 'decision-2026-11-03-db' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Decisions' }),
    ).toBeInTheDocument();
    // Open the decision from Recent; its header has the source chip and the backlink chip.
    await userEvent.click(
      within(recent).getByRole('button', { name: 'decision-2026-11-03-db' }),
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Database' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'kickoff' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acme' })).toBeInTheDocument();
    // A link in the body opens the source in the same view, with its header.
    await userEvent.click(await screen.findByRole('link', { name: 'kickoff' }));
    expect(await screen.findByText('Kickoff body.')).toBeInTheDocument();
    expect(screen.getByText('deck')).toBeInTheDocument();
    expect(screen.getByText('12 slides')).toBeInTheDocument();
    expect(screen.getByLabelText('Note')).toHaveTextContent(
      'Kickoff deck; slide 7 pricing is outdated',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Database' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(
      await screen.findByRole('region', { name: 'Pinned' }),
    ).toBeInTheDocument();
    expect(a.calls).toContainEqual({
      channel: 'brain:read',
      args: ['b1', 'sources/2026-11-01-kickoff.md'],
    });
  });

  it('search replaces the cards and opens a hit', async () => {
    const a = installFakeApi({
      'brain:pages': () => rows,
      'brain:search': () => [
        {
          path: 'wiki/account.md',
          kind: 'page',
          title: 'Acme',
          line: 5,
          text: 'The CFO owns the budget.',
          anchor: 'roles',
        },
      ],
      'brain:read': () => ({
        text: '---\ntitle: Acme\n---\n\n# Acme\n\n## Roles\n\nThe CFO owns the budget.\n',
      }),
    });
    render(<BrainWiki brainId="b1" />);
    await screen.findByRole('region', { name: 'Pinned' });
    await userEvent.type(screen.getByLabelText('Search the brain'), 'budget');
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull();
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:search',
        args: ['b1', 'budget'],
      }),
    );
    expect(within(results).getByText('budget')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(
      await screen.findByText('The CFO owns the budget.'),
    ).toBeInTheDocument();
  });
});
