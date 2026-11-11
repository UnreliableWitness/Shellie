import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrainBook,
  BrainPageRow,
  BrainReads,
  BrainSourceRow,
} from '../../../shared/brain';
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
  pictures: [],
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

  it('says when the open page is in an open conflict, with Settle', async () => {
    setup();
    const onSettle = vi.fn();
    render(
      <BrainRead
        brainId="b1"
        since={null}
        onSettle={onSettle}
        conflicts={[
          {
            id: 'c1',
            kind: 'contradiction',
            page: 'wiki/account.md',
            detail: 'd',
            at: '2026-11-10T08:00:00.000Z',
            conflict: {
              id: 'c1',
              question: 'Who owns hosting?',
              claims: {
                a: {
                  page: 'wiki/account.md',
                  quote: 'x',
                  source: null,
                  date: null,
                },
                b: {
                  page: 'wiki/decision-2026-11-03-db.md',
                  quote: 'y',
                  source: null,
                  date: null,
                },
              },
              suggestion: null,
              reopens: null,
            },
          },
        ]}
      />,
    );
    await userEvent.click(
      await within(tree()).findByRole('button', { name: /Database/ }),
    );
    const line = await screen.findByRole('status', {
      name: 'Conflict on this page',
    });
    expect(line).toHaveTextContent('This page disagrees with Acme');
    await userEvent.click(within(line).getByRole('button', { name: 'Settle' }));
    expect(onSettle).toHaveBeenCalledWith('c1');
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

  it('Long reads opens in the reading column for a brain without a book too', async () => {
    setup();
    render(<BrainRead brainId="b1" since={null} canWrite />);
    await userEvent.click(
      await within(tree()).findByRole('button', { name: 'Long reads' }),
    );
    expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull();
    expect(
      within(reading()).getByRole('textbox', { name: 'Topic for a long read' }),
    ).toBeInTheDocument();
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

  describe('with a book', () => {
    const orphan = row({
      path: 'wiki/orphan.md',
      title: 'Orphan',
      type: 'component',
    });
    const book: BrainBook = {
      chapters: [
        {
          title: 'The project',
          summary: 'Mission',
          intro: 'About the project.',
          pages: ['wiki/account.md', 'wiki/scope-platform.md'],
        },
        { title: 'Risks', summary: '', intro: '', pages: [] },
      ],
    };
    const withBook = (over: FakeHandlers = {}) =>
      setup({
        'brain:pages': () => [...rows, orphan],
        'brain:book': () => book,
        ...over,
      });

    it("shows neither today's tree nor its landing while the book is still on its way", async () => {
      let release: (b: BrainBook) => void = () => undefined;
      const late = new Promise<BrainBook>((res) => (release = res));
      const a = withBook({ 'brain:book': () => late });
      render(<BrainRead brainId="b1" brainName="Acme brain" since={null} />);
      await waitFor(() =>
        expect(a.calls.some((c) => c.channel === 'brain:pages')).toBe(true),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull();
      expect(
        within(tree()).queryByRole('button', { name: 'Hosting' }),
      ).toBeNull();
      release(book);
      expect(
        await screen.findByRole('heading', { name: 'Acme brain' }),
      ).toBeInTheDocument();
    });

    it('lands on the front page, with the tree as the book, the back of the book and not placed yet', async () => {
      withBook();
      render(<BrainRead brainId="b1" brainName="Acme brain" since={null} />);
      expect(
        await screen.findByRole('heading', { name: 'Acme brain' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull();
      expect(
        within(tree()).queryByRole('button', { name: /Start here/ }),
      ).toBeNull();
      expect(
        await within(tree()).findByRole('button', { name: /The project/ }),
      ).toBeInTheDocument();
      expect(within(tree()).getByText('Risks').closest('button')).toBeNull();
      expect(
        within(tree()).getByRole('button', { name: 'Decisions 2' }),
      ).toBeInTheDocument();
      expect(
        within(tree()).getByRole('button', { name: 'Not placed yet 1' }),
      ).toBeInTheDocument();
      expect(
        within(tree()).getByRole('button', { name: 'Recent changes' }),
      ).toBeInTheDocument();
    });

    it('a chapter page opens the chapter, its page highlighted in the tree', async () => {
      withBook();
      render(<BrainRead brainId="b1" since={null} />);
      await userEvent.click(
        await within(tree()).findByRole('button', { name: /The project/ }),
      );
      expect(
        await within(reading()).findByText('About the project.'),
      ).toBeInTheDocument();
      const pagesList = await within(tree()).findByRole('list', {
        name: 'The project',
      });
      expect(
        within(pagesList).getByRole('button', { name: 'Acme' }),
      ).toHaveAttribute('aria-current', 'page');
    });

    it('a decision and an unplaced page open alone', async () => {
      withBook();
      render(<BrainRead brainId="b1" since={null} />);
      await userEvent.click(
        await within(tree()).findByRole('button', { name: 'Hosting' }),
      );
      expect(
        await within(reading()).findByRole('heading', {
          level: 2,
          name: 'Hosting',
        }),
      ).toBeInTheDocument();
      expect(within(reading()).queryByText('Chapter 1')).toBeNull();
      await userEvent.click(
        within(tree()).getByRole('button', { name: 'Orphan' }),
      );
      expect(
        await within(reading()).findByRole('heading', {
          level: 2,
          name: 'Orphan',
        }),
      ).toBeInTheDocument();
      expect(within(reading()).queryByText('Chapter 1')).toBeNull();
    });

    it('reading a chapter writes the continue key', async () => {
      withBook();
      render(<BrainRead brainId="b1" since={null} />);
      await userEvent.click(
        await within(tree()).findByRole('button', { name: /The project/ }),
      );
      await waitFor(() =>
        expect(localStorage.getItem('shellie.brain.continue.b1')).toBe(
          'wiki/account.md',
        ),
      );
    });

    it('a storage failure on writing the continue key is ignored', async () => {
      withBook();
      const set = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
          throw new Error('full');
        });
      render(<BrainRead brainId="b1" since={null} />);
      await userEvent.click(
        await within(tree()).findByRole('button', { name: /The project/ }),
      );
      expect(
        await within(reading()).findByText('About the project.'),
      ).toBeInTheDocument();
      set.mockRestore();
    });

    it('the front page offers Continue reading after a chapter was read', async () => {
      withBook();
      localStorage.setItem(
        'shellie.brain.continue.b1',
        'wiki/scope-platform.md',
      );
      render(<BrainRead brainId="b1" since={null} />);
      expect(
        await screen.findByRole('button', { name: /Continue reading/ }),
      ).toHaveTextContent('1 · The project › Scope: platform');
    });

    it('keeps Forward on the front page after going back', async () => {
      withBook();
      render(<BrainRead brainId="b1" since={null} />);
      await userEvent.click(
        await within(tree()).findByRole('button', { name: 'Hosting' }),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(
        await screen.findByRole('button', { name: 'Forward ›' }),
      ).toBeInTheDocument();
    });

    describe('long reads', () => {
      const READ = 'reads/the-project.md';
      const LETTER = 'reads/letters/2026-11-10-the-project.md';
      const longReads: BrainReads = {
        reads: [
          {
            path: READ,
            title: 'What the project is for',
            summary: 'Why Acme pays for it.',
            chapter: 'The project',
            topic: null,
            written: '2026-11-09',
            minutes: 6,
            hash: 'h1',
            stale: [],
          },
        ],
        letters: [
          {
            path: LETTER,
            title: 'The scope shrank',
            read: READ,
            written: '2026-11-10',
            minutes: 2,
            hash: 'l1',
          },
        ],
      };
      const withReads = (over: FakeHandlers = {}) =>
        withBook({
          'brain:reads': () => longReads,
          'brain:read': (_id, rel) => ({
            text:
              rel === READ
                ? '---\ntitle: What the project is for\n---\n\nAcme sells, see [the scope](../wiki/scope-platform.md).\n'
                : pageText(rel),
          }),
          ...over,
        });
      const frontLine = () =>
        within(reading()).findByRole('button', { name: /^Long reads/ });

      it('the front page says how many chapters have one and how many are unread, and leads to the list', async () => {
        const a = withReads();
        render(<BrainRead brainId="b1" since={null} canWrite />);
        expect(await frontLine()).toHaveTextContent(
          '1 of 1 chapter · 2 unread',
        );
        expect(
          within(
            within(tree()).getByRole('button', { name: /^Long reads/ }),
          ).getByRole('img', { name: 'unread' }),
        ).toBeInTheDocument();
        await userEvent.click(
          within(reading()).getByRole('button', { name: /^Long reads/ }),
        );
        expect(
          within(reading()).getByRole('heading', { name: 'Long reads' }),
        ).toBeInTheDocument();
        expect(
          within(tree()).getByRole('button', { name: /^Long reads/ }),
        ).toHaveAttribute('aria-current', 'page');
        expect(a.tracked).toContainEqual({
          type: 'event',
          name: 'brain.screen.action',
          props: { action: 'reads-open' },
        });
      });

      it('opens a long read from the list, marks it read, and its links lead back into the book', async () => {
        withReads();
        render(<BrainRead brainId="b1" since={null} canWrite />);
        await userEvent.click(
          await within(tree()).findByRole('button', { name: /^Long reads/ }),
        );
        await userEvent.click(
          within(
            within(reading()).getByRole('region', { name: 'By chapter' }),
          ).getByRole('button', { name: /What the project is for/ }),
        );
        const read = await within(reading()).findByRole('region', {
          name: 'What the project is for',
        });
        // The tree keeps Long reads as where the reader is.
        expect(
          within(tree()).getByRole('button', { name: /^Long reads/ }),
        ).toHaveAttribute('aria-current', 'page');
        await userEvent.click(
          within(read).getByRole('button', { name: 'Mark as read' }),
        );
        expect(
          within(read).getByRole('button', { name: 'Mark unread' }),
        ).toBeInTheDocument();
        expect(
          JSON.parse(localStorage.getItem('shellie.brain.reads.b1') ?? '{}'),
        ).toMatchObject({ [READ]: { hash: 'h1' } });
        await userEvent.click(
          within(read).getByRole('link', { name: 'the scope' }),
        );
        expect(
          await within(reading()).findByText('About the project.'),
        ).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(
          await within(reading()).findByRole('region', {
            name: 'What the project is for',
          }),
        ).toBeInTheDocument();
        // Its location line goes back to the list.
        await userEvent.click(
          within(reading()).getByRole('button', { name: 'Long reads' }),
        );
        expect(
          within(reading()).getByRole('heading', { name: 'Long reads' }),
        ).toBeInTheDocument();
      });

      it('what was read has no dot, on the front page or in the tree', async () => {
        withReads();
        localStorage.setItem(
          'shellie.brain.reads.b1',
          JSON.stringify({
            [READ]: { hash: 'h1', at: '2026-11-10T09:00:00.000Z' },
            [LETTER]: { hash: 'l1', at: '2026-11-10T09:00:00.000Z' },
          }),
        );
        render(<BrainRead brainId="b1" since={null} canWrite />);
        const line = await frontLine();
        expect(line).toHaveTextContent('1 of 1 chapter');
        expect(line).not.toHaveTextContent('unread');
        expect(
          within(
            within(tree()).getByRole('button', { name: /^Long reads/ }),
          ).queryByRole('img', { name: 'unread' }),
        ).toBeNull();
      });

      it('a brain that cannot write and has none shows no line on the front page', async () => {
        withBook();
        render(<BrainRead brainId="b1" brainName="Acme brain" since={null} />);
        expect(
          await screen.findByRole('heading', { name: 'Acme brain' }),
        ).toBeInTheDocument();
        expect(
          within(reading()).queryByRole('button', { name: /^Long reads/ }),
        ).toBeNull();
        // The list is still there, and says what is needed.
        await userEvent.click(
          within(tree()).getByRole('button', { name: 'Long reads' }),
        );
        expect(within(reading()).getByRole('status')).toHaveTextContent(
          'Update skills to write long reads',
        );
      });
    });

    it("a rejected book falls back to today's tree and landing", async () => {
      setup({
        'brain:book': () => {
          throw new Error('nope');
        },
      });
      render(<BrainRead brainId="b1" since={null} />);
      expect(
        await screen.findByRole('region', { name: 'Pinned' }),
      ).toBeInTheDocument();
      expect(
        within(tree()).getByRole('button', { name: /Start here/ }),
      ).toBeInTheDocument();
    });
  });
});
