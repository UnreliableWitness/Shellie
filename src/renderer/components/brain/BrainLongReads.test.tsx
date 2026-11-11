import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BrainBook, BrainReads } from '../../../shared/brain';
import { brainJob } from '../../test-helpers/brainFixture';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { BrainLongReads } from './BrainLongReads';
import { shortDay } from './recent';

const chapter = (title: string, pages = ['wiki/a.md']) => ({
  title,
  summary: '',
  intro: '',
  pages,
});
const book: BrainBook = {
  chapters: [chapter('Orders'), chapter('Returns'), chapter('Empty', [])],
};
const reads: BrainReads = {
  reads: [
    {
      path: 'reads/order-to-invoice.md',
      title: 'Order to invoice',
      summary: 'How an order becomes money.',
      chapter: 'Orders',
      topic: null,
      written: '2026-11-09',
      minutes: 7,
      hash: 'h1',
      stale: ['wiki/a.md'],
    },
    {
      path: 'reads/credit-notes.md',
      title: 'Credit notes',
      summary: 'When money goes back.',
      chapter: null,
      topic: 'Credit notes',
      written: '2026-11-10',
      minutes: 5,
      hash: 'h2',
      stale: [],
    },
  ],
  letters: [
    {
      path: 'reads/letters/2026-11-10-order-to-invoice.md',
      title: 'The credit check moved',
      read: 'reads/order-to-invoice.md',
      written: '2026-11-10',
      minutes: 2,
      hash: 'l1',
    },
  ],
};
const write = (
  target: string,
  status: 'queued' | 'running' | 'paused' | 'failed',
) => brainJob({ id: target, kind: 'write', source: null, target, status });

function show(over: Partial<React.ComponentProps<typeof BrainLongReads>> = {}) {
  const a = installFakeApi({
    'brain:write': () => brainJob({ kind: 'write' }),
  });
  const onOpen = vi.fn();
  render(
    <BrainLongReads
      brainId="b1"
      reads={reads}
      book={book}
      jobs={[]}
      canWrite
      marks={{}}
      onOpen={onOpen}
      {...over}
    />,
  );
  return { ...a, onOpen };
}
const section = (name: string) => screen.getByRole('region', { name });

describe('BrainLongReads', () => {
  it('lists the letters, a line per chapter with pages, and the long reads on a topic', async () => {
    const { onOpen } = show({
      marks: {
        'reads/credit-notes.md': {
          hash: 'h2',
          at: '2026-11-11T09:00:00Z',
          read: true,
        },
      },
    });
    const letters = section('Letters');
    expect(
      within(letters).getByRole('button', { name: /The credit check moved/ }),
    ).toHaveTextContent('About Order to invoice');
    const chapters = section('By chapter');
    const orders = within(chapters).getByRole('button', {
      name: /Order to invoice/,
    });
    expect(orders).toHaveTextContent('out of date');
    expect(orders).toHaveTextContent(
      `7 min · written ${shortDay('2026-11-09')}`,
    );
    expect(
      within(orders).getByRole('img', { name: 'unread' }),
    ).toBeInTheDocument();
    expect(within(chapters).getByText('No long read yet')).toBeInTheDocument();
    expect(within(chapters).queryByText('Empty')).toBeNull();
    const topic = within(section('On a topic')).getByRole('button', {
      name: /Credit notes/,
    });
    expect(topic).toHaveTextContent(
      `5 min · written ${shortDay('2026-11-10')} · read`,
    );
    expect(within(topic).queryByRole('img', { name: 'unread' })).toBeNull();
    await userEvent.click(orders);
    expect(onOpen).toHaveBeenCalledWith('reads/order-to-invoice.md');
  });

  it('Write asks for the long read of a chapter', async () => {
    const { calls, tracked } = show();
    await userEvent.click(
      screen.getByRole('button', { name: 'Write a long read on Returns' }),
    );
    expect(calls).toContainEqual({
      channel: 'brain:write',
      args: ['b1', 'chapter:Returns'],
    });
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'brain.screen.action',
      props: { action: 'read-write', target: 'chapter' },
    });
  });

  it.each([
    ['running', 'Writing…'],
    ['queued', 'Queued'],
    ['paused', 'Paused: daily token cap'],
  ] as const)(
    'a chapter being written (%s) says so, without Write',
    (status, text) => {
      show({ jobs: [write('chapter:Returns', status)] });
      expect(within(section('By chapter')).getByText(text)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Write a long read on Returns' }),
      ).toBeNull();
    },
  );

  it('a chapter whose last try failed says so, and can be tried again', () => {
    show({ jobs: [write('chapter:Returns', 'failed')] });
    expect(
      within(section('By chapter')).getByText(
        'The last try failed, see Activity in Add',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Write a long read on Returns' }),
    ).toBeInTheDocument();
  });

  it('asks for a long read on a topic, and shows it while it is written', async () => {
    const { calls, tracked } = show({
      jobs: [write('topic:Stock counts', 'running')],
    });
    const topics = section('On a topic');
    expect(within(topics).getByText('Stock counts')).toBeInTheDocument();
    expect(within(topics).getByText('Writing…')).toBeInTheDocument();
    const field = within(topics).getByRole('textbox', {
      name: 'Topic for a long read',
    });
    const submit = within(topics).getByRole('button', { name: 'Write' });
    expect(submit).toBeDisabled();
    await userEvent.type(field, '  How returns are credited {Enter}');
    expect(calls).toContainEqual({
      channel: 'brain:write',
      args: ['b1', 'topic:How returns are credited'],
    });
    expect(field).toHaveValue('');
    // What was asked is the reader's: the event carries only that a topic was.
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'brain.screen.action',
      props: { action: 'read-write', target: 'topic' },
    });
  });

  it('with skills that cannot write, says how to update them and offers no Write', () => {
    show({ canWrite: false });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Update skills to write long reads: Settings › Project › Brains.',
    );
    expect(screen.queryByRole('button', { name: /^Write/ })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    // What was written stays readable.
    expect(
      within(section('By chapter')).getByRole('button', {
        name: /Order to invoice/,
      }),
    ).toBeInTheDocument();
  });

  it('a topic whose last try failed stays in the list, and can be tried again', async () => {
    const { calls } = show({ jobs: [write('topic:Stock counts', 'failed')] });
    const topics = section('On a topic');
    expect(within(topics).getByText('Stock counts')).toBeInTheDocument();
    expect(
      within(topics).getByText('The last try failed, see Activity in Add'),
    ).toBeInTheDocument();
    await userEvent.click(
      within(topics).getByRole('button', {
        name: 'Write a long read on Stock counts',
      }),
    );
    expect(calls).toContainEqual({
      channel: 'brain:write',
      args: ['b1', 'topic:Stock counts'],
    });
  });

  it('a brain without a book or long reads shows only the topic field', () => {
    show({ book: null, reads: { reads: [], letters: [] } });
    expect(screen.queryByRole('region', { name: 'Letters' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'By chapter' })).toBeNull();
    expect(
      screen.getByRole('textbox', { name: 'Topic for a long read' }),
    ).toBeInTheDocument();
  });
});
