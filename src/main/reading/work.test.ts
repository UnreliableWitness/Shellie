import { describe, expect, it } from 'vitest';
import type { BrainPageRow } from '../../shared/brain';
import { workFor } from './work';

const row = (path: string, title: string, summary = ''): BrainPageRow => ({
  path,
  title,
  summary,
  type: 'subject',
  lastUpdated: null,
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
  pictures: [],
});

const reads = [
  {
    path: 'reads/returns.md',
    title: 'How a return travels',
    summary: 'From the customer back to the warehouse, and the credit note.',
  },
  {
    path: 'reads/invoices.md',
    title: 'Order to invoice',
    summary: 'How an order becomes an invoice.',
  },
];
const rows = [
  row(
    'wiki/subject-returns.md',
    'Returns',
    'The return flow, credit included.',
  ),
  row('wiki/subject-credit.md', 'Credit notes', 'When a credit note is made.'),
  row('wiki/subject-orders.md', 'Orders'),
];
const under = {
  'reads/returns.md': ['wiki/subject-returns.md', 'wiki/subject-credit.md'],
  'reads/invoices.md': ['wiki/subject-orders.md'],
};

describe('workFor', () => {
  it('gives an item the long read its words point at', () => {
    expect(
      workFor(
        [{ id: 412, title: 'Return flow: refund before receipt' }],
        reads,
        under,
        rows,
      ),
    ).toEqual({
      'reads/returns.md': [
        { id: 412, title: 'Return flow: refund before receipt' },
      ],
    });
  });

  it('counts the pages a long read was written from', () => {
    // No word of the title is in a long read's title; "credit" is in a summary (1) and finds two of its pages (2).
    expect(
      workFor([{ id: 7, title: 'Credit limits' }], reads, under, rows),
    ).toEqual({
      'reads/returns.md': [{ id: 7, title: 'Credit limits' }],
    });
    expect(
      workFor([{ id: 7, title: 'Credit limits' }], reads, {}, rows),
    ).toEqual({});
  });

  it('leaves an item without a long read when nothing scores enough', () => {
    expect(
      workFor(
        [{ id: 1, title: 'Upgrade the build pipeline' }],
        reads,
        under,
        rows,
      ),
    ).toEqual({});
    // One title word alone (2) is not enough.
    expect(
      workFor(
        [{ id: 2, title: 'Invoice' }],
        [{ path: 'reads/x.md', title: 'Invoice runs', summary: '' }],
        {},
        [],
      ),
    ).toEqual({});
  });

  it("uses the task's name as well as the title, and lists an item once", () => {
    expect(
      workFor(
        [
          { id: 9, title: 'Fix it', name: 'returns: credit note twice' },
          { id: 9, title: 'Fix it' },
          { id: 10, title: 'Returns of a returned return' },
        ],
        reads,
        under,
        rows,
      ),
    ).toEqual({
      'reads/returns.md': [
        { id: 9, title: 'Fix it' },
        { id: 10, title: 'Returns of a returned return' },
      ],
    });
  });

  it('breaks a tie by the pages, then by title', () => {
    const two = [
      { path: 'reads/b.md', title: 'Stock counts', summary: 'counts' },
      { path: 'reads/a.md', title: 'Stock counts again', summary: 'counts' },
    ];
    expect(
      Object.keys(workFor([{ id: 1, title: 'Stock counts' }], two, {}, [])),
    ).toEqual(['reads/b.md']);
    expect(
      Object.keys(
        workFor(
          [{ id: 1, title: 'Stock counts' }],
          two,
          { 'reads/a.md': ['wiki/stock.md'] },
          [row('wiki/stock.md', 'Stock')],
        ),
      ),
    ).toEqual(['reads/a.md']);
  });
});
