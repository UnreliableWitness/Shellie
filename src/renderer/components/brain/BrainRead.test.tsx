import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BrainPageRow, BrainSourceRow } from '../../../shared/brain';
import { installFakeApi, type FakeHandlers } from '../../test-helpers/fakeApi';
import { BrainRead as BrainReadView } from './BrainRead';
import { useBrainPages } from './BrainWiki';

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
  row({
    path: 'wiki/decision-2026-11-04-hosting.md',
    title: 'Hosting',
    type: 'decision',
  }),
];
const kickoff: BrainSourceRow = {
  path: 'sources/2026-11-01-kickoff.md',
  type: 'deck',
  ingestedAt: '2026-11-01T09:00:00.000Z',
  captured: true,
  original: 'sources/2026-11-01-kickoff.pptx',
  contents: '12 slides',
  note: 'Kickoff deck; slide 7 pricing is outdated',
};
const LOG =
  '# Log\n\n- 2026-11-04T10:00:00Z capture sources/2026-11-04-deck.md → pages: decision-2026-11-03-db; takeaway: x\n';
const pageText = (rel: string) =>
  rel === 'log.md'
    ? LOG
    : rel === 'sources/2026-11-01-kickoff.md'
      ? '---\ntitle: Kickoff\n---\n\n## p.2\n\nKickoff body.\n'
      : '---\ntitle: Database\n---\n\n# Database\n\nPostgres, see [kickoff](../sources/2026-11-01-kickoff.md#p2).\n';

const setup = (over: FakeHandlers = {}) =>
  installFakeApi({
    'brain:pages': () => rows,
    'brain:sources': () => [kickoff],
    'brain:read': (_id, rel) => ({ text: pageText(rel) }),
    ...over,
  });
const tree = () => screen.getByRole('navigation', { name: 'Brain pages' });
const reading = () => screen.getByRole('region', { name: 'Reading' });

/** BrainRead, shown, with its pages loaded the way the Brain screen loads them. */
function BrainRead(
  props: Omit<React.ComponentProps<typeof BrainReadView>, 'pages' | 'active'>,
) {
  const pages = useBrainPages(props.brainId);
  return <BrainReadView {...props} pages={pages} active />;
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});

describe('BrainRead', () => {
  it('lands on pinned pages and recent entries, and opens a page with working links', async () => {
    const a = setup();
    render(<BrainRead brainId="b1" since={null} />);
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
    // The landing has no all-pages list: the tree is the index.
    expect(screen.queryByRole('region', { name: 'Decisions' })).toBeNull();
    // Open the decision from Recent; the rail has the source and the backlink.
    await userEvent.click(
      within(recent).getByRole('button', { name: 'decision-2026-11-03-db' }),
    );
    expect(
      await within(reading()).findByRole('heading', {
        level: 2,
        name: 'Database',
      }),
    ).toBeInTheDocument();
    const rail = within(reading()).getByRole('complementary', {
      name: 'About this page',
    });
    expect(
      within(rail).getByRole('button', { name: 'kickoff' }),
    ).toBeInTheDocument();
    expect(
      within(rail).getByRole('button', { name: 'Acme' }),
    ).toBeInTheDocument();
    // A link in the body opens the source in the same view, with its header.
    await userEvent.click(
      await within(reading()).findByRole('link', { name: 'kickoff' }),
    );
    expect(await screen.findByText('Kickoff body.')).toBeInTheDocument();
    expect(within(reading()).getByText('deck')).toBeInTheDocument();
    expect(within(reading()).getByText('12 slides')).toBeInTheDocument();
    expect(within(reading()).getByLabelText('Note')).toHaveTextContent(
      'Kickoff deck; slide 7 pricing is outdated',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(
      await within(reading()).findByRole('heading', {
        level: 2,
        name: 'Database',
      }),
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

  it('the tree starts with Start here, then a group per type with its count; a click opens the page and marks it current', async () => {
    setup();
    render(<BrainRead brainId="b1" since={null} />);
    const start = await within(tree()).findByRole('button', {
      name: /Start here/,
    });
    expect(start).toHaveAttribute('aria-expanded', 'true');
    const startList = within(tree()).getByRole('list', { name: 'Start here' });
    expect(
      within(startList)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Acme', 'Scope: platform', 'W45', 'Recent changes']);
    expect(
      within(tree()).getByRole('button', { name: 'Decisions 2' }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(tree()).getByRole('button', { name: 'Sources 1' }),
    ).toBeInTheDocument();
    const decisions = within(tree()).getByRole('list', { name: 'Decisions' });
    await userEvent.click(
      within(decisions).getByRole('button', { name: 'Hosting' }),
    );
    expect(
      await within(reading()).findByRole('heading', {
        level: 2,
        name: 'Hosting',
      }),
    ).toBeInTheDocument();
    expect(
      within(decisions).getByRole('button', { name: 'Hosting' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      within(decisions).getByRole('button', { name: 'Database' }),
    ).not.toHaveAttribute('aria-current');
  });

  it('a collapsed group hides its items and stays collapsed after a remount', async () => {
    setup();
    const { unmount } = render(<BrainRead brainId="b1" since={null} />);
    const toggle = await within(tree()).findByRole('button', {
      name: 'Decisions 2',
    });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      within(tree()).queryByRole('button', { name: 'Hosting' }),
    ).toBeNull();
    unmount();
    render(<BrainRead brainId="b1" since={null} />);
    expect(
      await within(tree()).findByRole('button', { name: 'Decisions 2' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      within(tree()).queryByRole('button', { name: 'Hosting' }),
    ).toBeNull();
    expect(
      JSON.parse(localStorage.getItem('shellie.brain.tree.b1') ?? '[]'),
    ).toContain('decision');
  });

  it('a group collapsed while its page is open stays collapsed when the brain changes', async () => {
    const a = setup();
    render(<BrainRead brainId="b1" since={null} />);
    await userEvent.click(
      await within(tree()).findByRole('button', { name: 'Hosting' }),
    );
    const toggle = within(tree()).getByRole('button', { name: 'Decisions 2' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    act(() => a.emit('brain:changed', { brainId: 'b1' } as never));
    await waitFor(() =>
      expect(a.calls.filter((c) => c.channel === 'brain:pages')).toHaveLength(
        2,
      ),
    );
    expect(
      within(tree()).getByRole('button', { name: 'Decisions 2' }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('Recent changes and Log open in the reading column', async () => {
    setup();
    render(<BrainRead brainId="b1" since={null} />);
    await userEvent.click(
      await within(tree()).findByRole('button', { name: 'Recent changes' }),
    );
    expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull();
    expect(
      within(reading()).getByRole('region', { name: 'Recent' }),
    ).toBeInTheDocument();
    expect(
      within(tree()).getByRole('button', { name: 'Recent changes' }),
    ).toHaveAttribute('aria-current', 'page');
    await userEvent.click(within(tree()).getByRole('button', { name: 'Log' }));
    expect(
      await within(reading()).findByText(
        /capture sources\/2026-11-04-deck\.md/,
      ),
    ).toBeInTheDocument();
    expect(
      within(reading()).queryByRole('region', { name: 'Recent' }),
    ).toBeNull();
    // Opening a page from the log view leaves it.
    await userEvent.click(
      within(tree()).getByRole('button', { name: 'Hosting' }),
    );
    expect(
      await within(reading()).findByRole('heading', {
        level: 2,
        name: 'Hosting',
      }),
    ).toBeInTheDocument();
  });

  it('a page touched in the log since the last visit has the new dot', async () => {
    setup();
    render(<BrainRead brainId="b1" since="2026-11-03T00:00:00Z" />);
    const decisions = await within(tree()).findByRole('list', {
      name: 'Decisions',
    });
    expect(
      within(
        within(decisions).getByRole('button', { name: /Database/ }),
      ).getByLabelText('new'),
    ).toBeInTheDocument();
    expect(
      within(
        within(decisions).getByRole('button', { name: 'Hosting' }),
      ).queryByLabelText('new'),
    ).toBeNull();
  });

  it('search replaces the tree and opens a hit; Esc brings the tree back', async () => {
    const a = setup({
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
      'brain:read': (_id, rel) => ({
        text:
          rel === 'log.md'
            ? LOG
            : '---\ntitle: Acme\n---\n\n# Acme\n\n## Roles\n\nThe CFO owns the budget.\n',
      }),
    });
    render(<BrainRead brainId="b1" since={null} />);
    await within(tree()).findByRole('button', { name: 'Decisions 2' });
    await userEvent.type(screen.getByLabelText('Search the brain'), 'budget');
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(
      within(tree()).queryByRole('button', { name: 'Decisions 2' }),
    ).toBeNull();
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:search',
        args: ['b1', 'budget'],
      }),
    );
    expect(within(results).getByText('budget')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(
      await within(reading()).findByText('The CFO owns the budget.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Search the brain'));
    await userEvent.keyboard('{Escape}');
    expect(
      within(tree()).getByRole('button', { name: 'Decisions 2' }),
    ).toBeInTheDocument();
  });

  it('Cmd+K or Ctrl+K in the view focuses the search', async () => {
    setup();
    render(<BrainRead brainId="b1" since={null} />);
    const item = await within(tree()).findByRole('button', { name: 'Hosting' });
    item.focus();
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(screen.getByLabelText('Search the brain')).toHaveFocus();
    item.focus();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.getByLabelText('Search the brain')).toHaveFocus();
  });

  it('says nothing about an empty brain before the pages have answered', async () => {
    let answer: (rows: BrainPageRow[]) => void = () => undefined;
    setup({
      'brain:pages': () =>
        new Promise<BrainPageRow[]>((resolve) => {
          answer = resolve;
        }),
      'brain:sources': () => [],
      'brain:read': () => ({ text: '' }),
    });
    render(<BrainRead brainId="b1" since={null} />);
    await screen.findByLabelText('Search the brain');
    expect(
      screen.queryByText('No pages yet. Add a source in Add.'),
    ).not.toBeInTheDocument();
    answer([]);
    expect(
      await screen.findByText('No pages yet. Add a source in Add.'),
    ).toBeInTheDocument();
  });

  it('an empty brain says how to add something', async () => {
    setup({
      'brain:pages': () => [],
      'brain:sources': () => [],
      'brain:read': () => ({ text: '' }),
    });
    render(<BrainRead brainId="b1" since={null} />);
    expect(
      await screen.findByText('No pages yet. Add a source in Add.'),
    ).toBeInTheDocument();
  });
});
