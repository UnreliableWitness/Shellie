import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BrainPageRow, BrainSourceRow } from '../../../shared/brain';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { BrainPage } from './BrainPage';

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
  row({ path: 'wiki/account.md', title: 'Acme' }),
  row({
    path: 'wiki/decision-eu.md',
    title: 'Move invoicing to the EU region',
    summary: 'Invoicing runs in West Europe.',
    type: 'decision',
    sources: ['sources/2026-11-01-kickoff.md'],
    linkedFrom: ['wiki/account.md'],
  }),
  row({ path: 'wiki/plain.md', title: 'Plain' }),
];
const source = (path: string): BrainSourceRow => ({
  path,
  type: 'note',
  ingestedAt: '2026-11-01T09:00:00.000Z',
  captured: true,
  original: null,
  contents: null,
  note: null,
});
const sources = [
  source('sources/2026-11-01-kickoff.md'),
  source('sources/wiki/old-page.md'),
];
const pageText = (rel: string) =>
  rel === 'wiki/plain.md'
    ? '---\ntitle: Plain\n---\n\nJust a paragraph.\n'
    : rel.startsWith('sources/')
      ? '---\ntitle: Kickoff\n---\n\nKickoff body.\n'
      : '---\ntitle: Move invoicing\n---\n\n## What changes\n\nThe API moves.\n\n### Detail\n\nHourly replica.\n';

const fake = () =>
  installFakeApi({
    'brain:read': (_id, rel) => ({ text: pageText(rel) }),
    'brain:removeSource': () => undefined,
  });

const page = (
  path: string,
  extra: Partial<React.ComponentProps<typeof BrainPage>> = {},
) => (
  <BrainPage
    brainId="b1"
    path={path}
    rows={rows}
    sources={sources}
    canBack={false}
    canForward={false}
    onOpen={() => undefined}
    onBack={() => undefined}
    onForward={() => undefined}
    {...extra}
  />
);

describe('BrainPage', () => {
  it('with the rail: outline, backlinks, sources and Mark verified beside the body, no chips in the header', async () => {
    fake();
    const onOpen = vi.fn();
    render(page('wiki/decision-eu.md', { layout: 'rail', onOpen }));
    const outline = await screen.findByRole('region', {
      name: 'On this page',
    });
    expect(
      within(outline).getByRole('link', { name: 'What changes' }),
    ).toBeInTheDocument();
    expect(
      within(outline).getByRole('link', { name: 'Detail' }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(outline).getByRole('link', { name: 'Detail' }),
    );
    const linked = screen.getByRole('region', { name: 'Linked from' });
    await userEvent.click(within(linked).getByRole('button', { name: 'Acme' }));
    expect(onOpen).toHaveBeenCalledWith('wiki/account.md');
    const cited = screen.getByRole('region', { name: 'Sources' });
    expect(
      within(cited).getByRole('button', { name: 'kickoff' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark verified' }),
    ).toBeInTheDocument();
    const head = screen
      .getByRole('heading', {
        level: 2,
        name: 'Move invoicing to the EU region',
      })
      .closest('header') as HTMLElement;
    expect(within(head).queryAllByRole('button')).toEqual([]);
  });

  it('with the rail: a page without headings has no outline', async () => {
    fake();
    render(page('wiki/plain.md', { layout: 'rail' }));
    expect(await screen.findByText('Just a paragraph.')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'On this page' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark verified' }),
    ).toBeInTheDocument();
  });

  it('by default keeps the chips in the header and has no rail', async () => {
    fake();
    render(page('wiki/decision-eu.md'));
    const head = (
      await screen.findByRole('heading', {
        level: 2,
        name: 'Move invoicing to the EU region',
      })
    ).closest('header') as HTMLElement;
    expect(
      within(head).getByRole('button', { name: 'kickoff' }),
    ).toBeInTheDocument();
    expect(
      within(head).getByRole('button', { name: 'Acme' }),
    ).toBeInTheDocument();
    expect(
      within(head).getByRole('button', { name: 'Mark verified' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'On this page' }),
    ).not.toBeInTheDocument();
  });

  it('with the rail: a source can be removed; a sources/wiki/ mirror cannot', async () => {
    const a = fake();
    const onRemoved = vi.fn();
    const { rerender } = render(
      page('sources/2026-11-01-kickoff.md', { layout: 'rail', onRemoved }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove…' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove source' }),
    );
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(
      a.calls
        .filter((c) => c.channel === 'brain:removeSource')
        .map((c) => c.args),
    ).toEqual([['b1', 'sources/2026-11-01-kickoff.md']]);

    rerender(page('sources/wiki/old-page.md', { layout: 'rail', onRemoved }));
    expect(await screen.findByText('Kickoff body.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove…' }),
    ).not.toBeInTheDocument();
  });
});
