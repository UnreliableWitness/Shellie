import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BrainPageRow, BrainReads } from '../../../shared/brain';
import { brainJob } from '../../test-helpers/brainFixture';
import { installFakeApi, type FakeHandlers } from '../../test-helpers/fakeApi';
import { BrainLongRead } from './BrainLongRead';
import { shortDay } from './recent';

const READ = 'reads/order-to-invoice.md';
const LETTER = 'reads/letters/2026-11-10-order-to-invoice.md';
const ESSAY = [
  '---',
  'title: Order to invoice',
  'chapter: Orders',
  '---',
  '',
  '# Order to invoice',
  '',
  'An order is a promise, see [Orders](../wiki/subject-orders.md).',
  '',
  '> **Before you read on**',
  '> Why is the credit check first?',
  '>',
  '> **Answer**',
  '> Reserved stock is hard to release.',
  '',
  'After the check the order is released.',
  '',
  '## What the writer was missing',
  '',
  '- Why the limit is 5000.',
  '',
].join('\n');
const TOLD = [
  '---',
  'title: The credit check moved',
  `read: ${READ}`,
  '---',
  '',
  'The order of two steps changed.',
  '',
  '## What you read',
  'The check came first.',
  '',
  '## What holds now',
  'Stock is reserved first.',
  '',
  '## Why it changed',
  'The sources do not say.',
  '',
  '## What follows',
  'Ask about released stock.',
  '',
].join('\n');

const reads = (stale: string[] = []): BrainReads => ({
  reads: [
    {
      path: READ,
      title: 'Order to invoice',
      summary: 'How an order becomes money.',
      chapter: 'Orders',
      topic: null,
      written: '2026-11-09',
      minutes: 7,
      hash: 'h1',
      stale,
    },
  ],
  letters: [
    {
      path: LETTER,
      title: 'The credit check moved',
      read: READ,
      written: '2026-11-10',
      minutes: 2,
      hash: 'l1',
    },
  ],
});
const pages = [
  { path: 'wiki/subject-orders.md', title: 'Orders' },
  { path: 'wiki/scope.md', title: 'Scope' },
] as BrainPageRow[];

function show(
  over: Partial<React.ComponentProps<typeof BrainLongRead>> = {},
  handlers: FakeHandlers = {},
) {
  const a = installFakeApi({
    'brain:read': (_id, rel) => ({ text: rel === LETTER ? TOLD : ESSAY }),
    'brain:write': () => brainJob({ kind: 'write' }),
    ...handlers,
  });
  const props = {
    brainId: 'b1',
    path: READ,
    reads: reads(),
    rows: pages,
    marks: {},
    onMark: vi.fn(),
    jobs: [],
    keeper: null,
    newerShellie: false,
    canWrite: true,
    canBack: true,
    canForward: false,
    onOpen: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onList: vi.fn(),
    ...over,
  };
  render(<BrainLongRead {...props} />);
  return { ...a, props };
}
const article = (name: string) => screen.findByRole('region', { name });
const action = (props: Record<string, string>) => ({
  type: 'event',
  name: 'brain.screen.action',
  props,
});

describe('BrainLongRead', () => {
  it('shows a long read with its chapter, reading time and day, and its links open pages', async () => {
    const { props, tracked } = show();
    const read = await article('Order to invoice');
    expect(
      within(read).getByRole('heading', { level: 2, name: 'Order to invoice' }),
    ).toBeInTheDocument();
    // The title is the header's: the essay's own heading is not shown twice.
    expect(within(read).getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(within(read).getByText('Long read · Orders')).toBeInTheDocument();
    expect(
      within(read).getByText('How an order becomes money.'),
    ).toBeInTheDocument();
    expect(
      within(read).getByText(`7 min · written ${shortDay('2026-11-09')}`),
    ).toBeInTheDocument();
    await userEvent.click(within(read).getByRole('link', { name: 'Orders' }));
    expect(props.onOpen).toHaveBeenCalledWith(
      'wiki/subject-orders.md',
      undefined,
    );
    expect(tracked).toContainEqual(
      action({ action: 'read-open', kind: 'read' }),
    );
  });

  it('holds the answer back until it is asked for, and keeps the gaps closed', async () => {
    const { tracked } = show();
    const read = await article('Order to invoice');
    const q = within(read).getByRole('complementary', {
      name: 'Before you read on',
    });
    expect(
      within(q).getByText('Why is the credit check first?'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Reserved stock is hard to release.')).toBeNull();
    await userEvent.click(
      within(q).getByRole('button', { name: 'Show the answer' }),
    );
    const answer = within(q).getByText('Reserved stock is hard to release.');
    // The button is gone: the answer has the focus, so the keyboard reads on from there.
    expect(answer.closest('.brain-read-answer')).toHaveFocus();
    expect(tracked).toContainEqual(action({ action: 'read-answer' }));
    const gaps = within(read)
      .getByText('What the writer was missing')
      .closest('details');
    expect(gaps).not.toHaveAttribute('open');
    expect(gaps).toHaveTextContent('Why the limit is 5000.');
  });

  it('says which pages changed since it was written, and Update asks for the rewrite', async () => {
    const { calls, props } = show({
      reads: reads([
        'wiki/subject-orders.md',
        'wiki/scope.md',
        'wiki/a.md',
        'wiki/b.md',
        'wiki/c.md',
      ]),
    });
    const stale = await screen.findByRole('status', { name: 'Out of date' });
    expect(stale).toHaveTextContent(
      '5 pages changed since this was written: Orders, Scope, wiki/a.md and 2 more',
    );
    await userEvent.click(within(stale).getByRole('button', { name: 'Scope' }));
    expect(props.onOpen).toHaveBeenCalledWith('wiki/scope.md');
    await userEvent.click(
      within(stale).getByRole('button', { name: 'Update' }),
    );
    expect(calls).toContainEqual({
      channel: 'brain:write',
      args: ['b1', READ],
    });
  });

  it('an update that is waiting or running says so, and cannot be asked twice', async () => {
    show({
      reads: reads(['wiki/scope.md']),
      jobs: [
        brainJob({
          kind: 'write',
          source: null,
          target: READ,
          status: 'running',
        }),
      ],
    });
    const box = await screen.findByRole('status', { name: 'Out of date' });
    expect(
      within(box).getByRole('button', { name: 'Updating…' }),
    ).toBeDisabled();
  });

  it('a failed update says so; without the skills there is no Update', async () => {
    show({
      reads: reads(['wiki/scope.md']),
      canWrite: false,
      jobs: [
        brainJob({
          kind: 'write',
          source: null,
          target: READ,
          status: 'failed',
        }),
      ],
    });
    const box = await screen.findByRole('status', { name: 'Out of date' });
    expect(box).toHaveTextContent(
      'The last update failed, see Activity in Add.',
    );
    expect(within(box).queryByRole('button', { name: 'Update' })).toBeNull();
  });

  it('a long read that is up to date has no such line, and links to its newest letter', async () => {
    const { props } = show();
    const read = await article('Order to invoice');
    expect(screen.queryByRole('status', { name: 'Out of date' })).toBeNull();
    expect(
      within(read).getByText(new RegExp(`Changed ${shortDay('2026-11-10')}`)),
    ).toBeInTheDocument();
    expect(
      within(read).getByRole('img', { name: 'unread' }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(read).getByRole('button', { name: 'The credit check moved' }),
    );
    expect(props.onOpen).toHaveBeenCalledWith(LETTER);
  });

  it('shows a letter as its four sections, with the long read it is about', async () => {
    const { props, tracked } = show({ path: LETTER });
    const letter = await article('The credit check moved');
    expect(within(letter).getByText('Letter')).toBeInTheDocument();
    expect(
      within(letter).getByText('The order of two steps changed.'),
    ).toBeInTheDocument();
    expect(
      within(letter)
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label')),
    ).toEqual([
      'What you read',
      'What holds now',
      'Why it changed',
      'What follows',
    ]);
    const was = within(letter).getByRole('group', { name: 'What you read' });
    expect(was).toHaveClass('is-read');
    expect(was).toHaveTextContent('The check came first.');
    await userEvent.click(
      within(letter).getByRole('button', { name: 'Order to invoice' }),
    );
    expect(props.onOpen).toHaveBeenCalledWith(READ);
    expect(screen.getByLabelText('Location')).toHaveTextContent(
      'Long reads › Letters › The credit check moved',
    );
    expect(tracked).toContainEqual(
      action({ action: 'read-open', kind: 'letter' }),
    );
  });

  it('marks as read by hand, for the text as it is', async () => {
    const { props, tracked } = show();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Mark as read' }),
    );
    expect(props.onMark).toHaveBeenCalledWith(
      expect.objectContaining({ path: READ, hash: 'h1' }),
      true,
    );
    expect(tracked).toContainEqual(action({ action: 'read-mark' }));
  });

  it('a read one says when, and can be unmarked', async () => {
    const at = '2026-11-11T09:00:00.000Z';
    const first = show({ marks: { [READ]: { hash: 'h1', at, read: true } } });
    const read = await article('Order to invoice');
    expect(
      within(read).getByText(`Read on ${shortDay('2026-11-11')}`),
    ).toBeInTheDocument();
    await userEvent.click(
      within(read).getByRole('button', { name: 'Mark unread' }),
    );
    expect(first.props.onMark).toHaveBeenCalledWith(
      expect.objectContaining({ path: READ }),
      false,
    );
  });

  it('a mark for an older text of the long read does not count', async () => {
    show({
      marks: {
        [READ]: { hash: 'old', at: '2026-11-08T09:00:00.000Z', read: true },
      },
    });
    expect(
      await screen.findByRole('button', { name: 'Mark as read' }),
    ).toBeInTheDocument();
  });

  it('goes back to the list from its location line, and says when the file cannot be read', async () => {
    const { props } = show(
      {},
      {
        'brain:read': () => {
          throw new Error('No such file');
        },
      },
    );
    expect(await screen.findByText('No such file')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Long reads' }));
    expect(props.onList).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Order to invoice' }),
      ).toBeNull(),
    );
  });
});
