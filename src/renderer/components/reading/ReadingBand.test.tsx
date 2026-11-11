import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReadingBrain } from '../../../shared/reading';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import {
  readingBrain,
  readingLetter,
  readingRead,
  readMark,
} from '../../test-helpers/readingFixture';
import { ReadingBand } from './ReadingBand';

const work = [{ id: 412, title: 'Return flow' }];
const acme = readingBrain({
  reads: [
    readingRead({ work }),
    readingRead({
      path: 'reads/orders.md',
      title: 'Order to invoice',
      chapter: 'Orders',
      hash: 'o2',
      minutes: 7,
    }),
    readingRead({
      path: 'reads/stock.md',
      title: 'Stock',
      chapter: 'Returns',
      minutes: 4,
    }),
    readingRead({ path: 'reads/later.md', title: 'A topic', topic: 't' }),
  ],
  letters: [
    readingLetter({
      path: 'reads/letters/2026-11-11-orders.md',
      read: 'reads/orders.md',
    }),
  ],
  marks: { 'reads/orders.md': readMark('o1') },
});

function show(reading: ReadingBrain[], readingNudges = true) {
  const a = installFakeApi();
  useStore.setState({
    reading,
    screen: { kind: 'home' },
    settings: { readingNudges } as never,
  });
  render(<ReadingBand />);
  return a;
}

beforeEach(() => useStore.setState({ reading: [], settings: null }));

describe('ReadingBand', () => {
  it('lists per brain how far the reader is and what is up next, with why', () => {
    show([acme]);
    const band = screen.getByRole('region', { name: 'Reading' });
    expect(within(band).getByText(/1 of 5 read · about/)).toBeInTheDocument();
    const rows = within(band)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(rows).toEqual([
      'Acme',
      'How a return becomes a creditfor #412 Return flow · 9 min',
      'The credit check moveda letter: Order to invoice changed · 2 min',
      'Stocknext in the book: Returns · 4 min',
    ]);
  });

  it('opens a piece in its brain’s Read view, and says only why and what kind', async () => {
    const { tracked } = show([acme]);
    await userEvent.click(
      screen.getByRole('button', { name: /The credit check moved/ }),
    );
    expect(useStore.getState().screen).toMatchObject({
      kind: 'brain',
      brainId: 'b1',
      open: { path: 'reads/letters/2026-11-11-orders.md' },
    });
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'reading.open',
      props: { from: 'home', why: 'changed', kind: 'letter' },
    });
  });

  it('opens the brain from its name', async () => {
    show([acme]);
    await userEvent.click(screen.getByRole('button', { name: 'Acme' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'brain',
      brainId: 'b1',
    });
  });

  it('leaves out a brain with nothing up next, and is absent with none', () => {
    const done = readingBrain({
      brainId: 'b2',
      name: 'Globex',
      reads: [readingRead({ chapter: 'Orders' })],
      marks: { 'reads/returns.md': readMark('h1') },
    });
    show([acme, done]);
    expect(screen.getByRole('button', { name: 'Acme' })).toBeInTheDocument();
    expect(screen.queryByText('Globex')).toBeNull();
  });

  it('is absent with nothing to read anywhere', () => {
    show([
      readingBrain({
        reads: [readingRead({ chapter: 'Orders' })],
        marks: { 'reads/returns.md': readMark('h1') },
      }),
    ]);
    expect(screen.queryByRole('region', { name: 'Reading' })).toBeNull();
  });

  it('is absent when the nudges are off', () => {
    show([acme], false);
    expect(screen.queryByRole('region', { name: 'Reading' })).toBeNull();
  });
});
