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
  pictures: [],
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

  it('a source with pictures not interpreted gets a warn tag and the Pictures panel above its text', async () => {
    const counts = {
      total: 3,
      described: 1,
      skipped: 0,
      missing: 1,
      dropped: 1,
      accepted: 0,
      tiny: 0,
    };
    installFakeApi({
      'brain:read': (_id, rel) => ({ text: pageText(rel) }),
      'brain:asset': (_id, rel) => `shellie-asset://${rel}`,
      'brain:pictures': (_id, src) => ({
        source: src,
        counts,
        rows: [
          {
            path: 'sources/2026-11-01-kickoff-assets/slide-1-1.png',
            label: 'Slide 1',
            alt: null,
            status: 'missing',
            pages: [],
            reason: null,
            fix: null,
            where: null,
          },
        ],
      }),
    });
    render(page('sources/2026-11-01-kickoff.md', { layout: 'rail' }));
    expect(
      await screen.findByText('2 pictures not interpreted', {
        selector: '.tag-warn',
      }),
    ).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: 'Pictures' });
    expect(
      panel.compareDocumentPosition(screen.getByText('Kickoff body.')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('a wiki page and a source without gaps get no picture tag', async () => {
    const a = installFakeApi({
      'brain:read': (_id, rel) => ({ text: pageText(rel) }),
    });
    const { rerender } = render(page('wiki/plain.md', { layout: 'rail' }));
    expect(await screen.findByText('Just a paragraph.')).toBeInTheDocument();
    expect(a.calls.some((c) => c.channel === 'brain:pictures')).toBe(false);
    rerender(page('sources/2026-11-01-kickoff.md', { layout: 'rail' }));
    expect(await screen.findByText('Kickoff body.')).toBeInTheDocument();
    await waitFor(() =>
      expect(a.calls.some((c) => c.channel === 'brain:pictures')).toBe(true),
    );
    expect(screen.queryByText(/not interpreted/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Pictures' }),
    ).not.toBeInTheDocument();
  });

  it('sources/wiki shows the pictures of the wiki mirror, with no file to read', async () => {
    const a = installFakeApi({
      'brain:read': (_id, rel) => ({ text: pageText(rel) }),
      'brain:asset': (_id, rel) => `shellie-asset://${rel}`,
      'brain:pictures': (_id, src) => ({
        source: src,
        counts: {
          total: 1,
          described: 0,
          skipped: 0,
          missing: 0,
          dropped: 1,
          accepted: 0,
          tiny: 0,
        },
        rows: [
          {
            path: null,
            label: 'Wiki attachment',
            alt: 'diagram.emf',
            status: 'dropped',
            pages: [],
            reason: 'EMF attachments cannot be viewed',
            fix: 'Save it as PNG in the wiki',
            where: 'diagram.emf',
          },
        ],
      }),
    });
    render(page('sources/wiki', { layout: 'rail' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Wiki mirror' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('1 picture not interpreted', {
        selector: '.tag-warn',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Fine, I know' }),
    ).toBeInTheDocument();
    expect(a.calls.some((c) => c.channel === 'brain:read')).toBe(false);
  });

  describe('pictures cited in a page', () => {
    const cited =
      '---\ntitle: Move invoicing\n---\n\nSee [the slide](../sources/a-assets/x.png) for it.\n';
    const read = (assetFails = false) =>
      installFakeApi({
        'brain:read': () => ({ text: cited }),
        'brain:asset': (_id, rel) => {
          if (assetFails) throw new Error('gone');
          return `shellie-asset://${rel}`;
        },
      });

    it('the rail layout shows the picture as a figure with its caption; a click opens the lightbox', async () => {
      read();
      render(page('wiki/decision-eu.md', { layout: 'rail' }));
      const img = await screen.findByRole('img', { name: 'the slide' });
      expect(img).toHaveAttribute(
        'src',
        'shellie-asset://sources/a-assets/x.png',
      );
      expect(document.querySelector('.doc-figure-cap')?.textContent).toBe(
        'the slide',
      );
      expect(
        screen.getByRole('link', { name: 'the slide' }),
      ).toBeInTheDocument();
      await userEvent.click(img);
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });

    it('a picture that fails leaves the link and no image, caption or alt text', async () => {
      const a = read(true);
      render(page('wiki/decision-eu.md', { layout: 'rail' }));
      await waitFor(() =>
        expect(a.calls.some((c) => c.channel === 'brain:asset')).toBe(true),
      );
      expect(
        await screen.findByRole('link', { name: 'the slide' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(document.querySelector('.doc-figure')).toBeNull();
      expect(screen.getAllByText('the slide')).toHaveLength(1);
    });

    it('the chips layout shows no figure', async () => {
      const a = read();
      render(page('wiki/decision-eu.md'));
      expect(
        await screen.findByRole('link', { name: 'the slide' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(a.calls.some((c) => c.channel === 'brain:asset')).toBe(false);
    });
  });
});
