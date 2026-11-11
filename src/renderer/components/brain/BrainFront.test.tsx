import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BrainBook, BrainPageRow } from '../../../shared/brain';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { BrainFront } from './BrainFront';

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
  row({ path: 'wiki/why.md', title: 'Why', summary: 'Why we exist.' }),
  row({ path: 'wiki/goals.md', title: 'Goals' }),
  row({ path: 'wiki/flow.md', title: 'Order flow' }),
];
const book: BrainBook = {
  chapters: [
    {
      title: 'The project',
      summary: 'Mission and goals',
      intro: '',
      pages: ['wiki/why.md', 'wiki/goals.md'],
    },
    { title: 'Risks', summary: 'ignored', intro: '', pages: [] },
    {
      title: 'Architecture',
      summary: 'The order flow',
      intro: '',
      pages: ['wiki/flow.md'],
    },
  ],
};
const show = (
  over: Partial<React.ComponentProps<typeof BrainFront>> = {},
  onOpen = vi.fn(),
) => {
  installFakeApi();
  render(
    <BrainFront
      brainName="Order platform"
      book={book}
      rows={rows}
      newPaths={new Set()}
      continueAt={null}
      onOpen={onOpen}
      {...over}
    />,
  );
  return onOpen;
};
const contents = () => screen.getByRole('list', { name: 'Contents' });

describe('BrainFront', () => {
  it('has the brain name and the first chapter first page summary as introduction', () => {
    show();
    expect(
      screen.getByRole('heading', { name: 'Order platform' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Why we exist.')).toBeInTheDocument();
  });

  it('lists a row per chapter with number, title, summary and section count', () => {
    show();
    const items = within(contents()).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('1');
    expect(items[0]).toHaveTextContent('The project');
    expect(items[0]).toHaveTextContent('Mission and goals');
    expect(items[0]).toHaveTextContent('2 sections');
    expect(items[2]).toHaveTextContent('1 section');
    expect(items[2]).not.toHaveTextContent('1 sections');
  });

  it('shows a chapter with no pages as nothing captured, and not a button', () => {
    show();
    const item = within(contents()).getAllByRole('listitem')[1];
    expect(item).toHaveTextContent('Risks');
    expect(item).toHaveTextContent('Nothing captured on this yet');
    expect(item).not.toHaveTextContent('ignored');
    expect(within(item).queryByRole('button')).toBeNull();
  });

  it('opens the first page of a chapter on a click', async () => {
    const onOpen = show();
    await userEvent.click(
      within(contents()).getByRole('button', { name: /Architecture/ }),
    );
    expect(onOpen).toHaveBeenCalledWith('wiki/flow.md');
  });

  it('marks a chapter holding a new page with the dot', () => {
    show({ newPaths: new Set(['wiki/goals.md']) });
    const items = within(contents()).getAllByRole('listitem');
    expect(within(items[0]).getByLabelText('new')).toBeInTheDocument();
    expect(within(items[2]).queryByLabelText('new')).toBeNull();
  });

  it('offers Continue reading only for a page still in the book, labelled with chapter and page', async () => {
    const onOpen = show({ continueAt: { path: 'wiki/flow.md' } });
    const go = screen.getByRole('button', { name: /Continue reading/ });
    expect(go).toHaveTextContent('3 · Architecture › Order flow');
    await userEvent.click(go);
    expect(onOpen).toHaveBeenCalledWith('wiki/flow.md');
  });

  it('has no Continue reading for a page that left the book', () => {
    show({ continueAt: { path: 'wiki/gone.md' } });
    expect(
      screen.queryByRole('button', { name: /Continue reading/ }),
    ).toBeNull();
  });

  it('leads to the long reads when told about them', async () => {
    const onReads = vi.fn();
    show({
      longReads: { written: 1, chapters: 3, unread: 2, onOpen: onReads },
    });
    const line = screen.getByRole('button', { name: /^Long reads/ });
    expect(line).toHaveTextContent('1 of 3 chapters · 2 unread');
    await userEvent.click(line);
    expect(onReads).toHaveBeenCalled();
  });

  it('says nothing of unread long reads when all are read, and has no line without them', () => {
    show({
      longReads: { written: 3, chapters: 3, unread: 0, onOpen: vi.fn() },
    });
    expect(
      screen.getByRole('button', { name: /^Long reads/ }),
    ).toHaveTextContent(/3 of 3 chapters$/);
  });

  it('renders the graph of the pages', () => {
    show();
    expect(screen.getByLabelText('How pages link')).toBeInTheDocument();
  });
});
