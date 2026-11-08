import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainBook, BrainPageRow } from '../../../shared/brain';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { BrainChapter } from './BrainChapter';

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
const PIC = 'sources/x-assets/slide.png';
const rows = [
  row({
    path: 'wiki/one.md',
    title: 'Overview',
    summary: 'Summary that is also the first paragraph.',
    confidence: 'high',
    verified: '2026-11-01',
    pictures: [PIC],
    sources: ['sources/deck.md'],
  }),
  row({
    path: 'wiki/two.md',
    title: 'Order flow',
    pictures: [PIC],
    linkedFrom: ['wiki/one.md'],
  }),
  row({ path: 'wiki/three.md', title: 'Integrations' }),
];
const book: BrainBook = {
  chapters: [
    {
      title: 'The project',
      summary: 's',
      intro: 'Intro zero.',
      pages: ['wiki/z.md'],
    },
    { title: 'Empty', summary: '', intro: '', pages: [] },
    {
      title: 'Architecture',
      summary: 'How it fits.',
      intro: 'This chapter covers the shape of it.',
      pages: ['wiki/one.md', 'wiki/two.md', 'wiki/three.md'],
    },
    { title: 'Not empty', summary: '', intro: '', pages: ['wiki/last.md'] },
  ],
};
const text = (rel: string) =>
  rel === 'wiki/one.md'
    ? `---\ntitle: Overview\nconfidence: high\n---\n\n# Overview\n\nSummary that is also the first paragraph.\n\n[Slide 4](../${PIC})\n\n## Notes\n\nOne notes.\n\n[Order flow](two.md)\n`
    : rel === 'wiki/two.md'
      ? `---\ntitle: Order flow\n---\n\nOrders move.\n\n[Slide 4 again](../${PIC})\n\n## Notes\n\nTwo notes.\n\n## Detail\n\nDeep.\n`
      : `---\ntitle: Integrations\n---\n\nPartners.\n`;

const fake = (over: Parameters<typeof installFakeApi>[0] = {}) =>
  installFakeApi({
    'brain:read': (_id, rel) => ({ text: text(rel) }),
    'brain:asset': () => 'data:image/png;base64,AAAA',
    'brain:verify': () => ({ verified: '2026-11-08' }),
    ...over,
  });

const chapter = (
  extra: Partial<React.ComponentProps<typeof BrainChapter>> = {},
) => (
  <BrainChapter
    brainId="b1"
    book={book}
    index={2}
    path="wiki/one.md"
    rows={rows}
    canBack={false}
    canForward={false}
    onOpen={() => undefined}
    onBack={() => undefined}
    onForward={() => undefined}
    {...extra}
  />
);

const scrolled = vi.fn();
beforeEach(() => {
  scrolled.mockReset();
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled(this);
  };
});
afterEach(() => vi.useRealTimers());

describe('BrainChapter', () => {
  it('shows the chapter title and intro, then every page in book order', async () => {
    const { calls } = fake();
    render(chapter());
    expect(
      screen.getByText('This chapter covers the shape of it.'),
    ).toBeTruthy();
    expect(screen.getByText('Chapter 3')).toBeTruthy();
    await screen.findByText('Partners.');
    const titles = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Architecture',
        'Overview',
        'Order flow',
        'Integrations',
      ]),
    );
    expect(titles.indexOf('Overview')).toBeLessThan(
      titles.indexOf('Order flow'),
    );
    expect(titles.indexOf('Order flow')).toBeLessThan(
      titles.indexOf('Integrations'),
    );
    const reads = calls
      .filter((c) => c.channel === 'brain:read')
      .map((c) => c.args[1]);
    expect(reads).toEqual(['wiki/one.md', 'wiki/two.md', 'wiki/three.md']);
  });

  it('shows no summary beyond the first paragraph, and no repeated title', async () => {
    fake();
    render(chapter());
    await screen.findByText('Partners.');
    expect(
      screen.getAllByText('Summary that is also the first paragraph.'),
    ).toHaveLength(1);
    expect(screen.getAllByText('Overview', { selector: 'h1,h2' })).toHaveLength(
      1,
    );
  });

  it('shows a picture once across the chapter', async () => {
    fake();
    render(chapter());
    await screen.findByText('Partners.');
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1));
    expect(screen.getByRole('img', { name: 'Slide 4' })).toBeTruthy();
  });

  it('gives each section its own heading ids', async () => {
    fake();
    const { container } = render(chapter());
    await screen.findByText('Partners.');
    expect(container.querySelector('[id="section-0-notes"]')).toBeTruthy();
    expect(container.querySelector('[id="section-1-notes"]')).toBeTruthy();
    const ids = Array.from(container.querySelectorAll('[id]'), (e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('puts the tags in the section', async () => {
    fake();
    const { container } = render(chapter());
    await screen.findByText('Partners.');
    const first = container.querySelector('section[data-path="wiki/one.md"]')!;
    expect(within(first as HTMLElement).getByText('high')).toBeTruthy();
    expect(within(first as HTMLElement).getByText(/verified/)).toBeTruthy();
  });

  it('scrolls to the section of path, to its heading with an anchor, to the top for the first page', async () => {
    fake();
    const first = render(chapter());
    await screen.findByText('Partners.');
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect(scrolled.mock.calls.at(-1)![0]).toHaveProperty(
      'className',
      expect.stringContaining('brain-page-bar'),
    );
    first.unmount();

    scrolled.mockReset();
    const second = render(chapter({ path: 'wiki/two.md' }));
    await screen.findByText('Partners.');
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect((scrolled.mock.calls.at(-1)![0] as HTMLElement).dataset.path).toBe(
      'wiki/two.md',
    );

    scrolled.mockReset();
    second.rerender(chapter({ path: 'wiki/two.md', anchor: 'detail' }));
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect((scrolled.mock.calls.at(-1)![0] as HTMLElement).id).toBe(
      'section-1-detail',
    );
  });

  it('scrolls again when the page already shown is opened again', async () => {
    fake();
    const view = render(chapter({ path: 'wiki/two.md', opened: 1 }));
    await screen.findByText('Partners.');
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    scrolled.mockReset();
    view.rerender(chapter({ path: 'wiki/two.md', opened: 1 }));
    expect(scrolled).not.toHaveBeenCalled();
    view.rerender(chapter({ path: 'wiki/two.md', opened: 2 }));
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
    expect((scrolled.mock.calls.at(-1)![0] as HTMLElement).dataset.path).toBe(
      'wiki/two.md',
    );
  });

  it('opens a link to another page of the chapter through onOpen', async () => {
    fake();
    const onOpen = vi.fn();
    render(chapter({ onOpen }));
    await screen.findByText('Partners.');
    await userEvent.click(document.querySelector('a[href="two.md"]')!);
    expect(onOpen).toHaveBeenCalledWith('wiki/two.md', undefined);
  });

  it('opens the neighbouring non-empty chapters, none at the ends', async () => {
    fake();
    const onOpen = vi.fn();
    const mid = render(chapter({ onOpen }));
    await screen.findByText('Partners.');
    await userEvent.click(
      screen.getByRole('button', { name: /Previous chapter/ }),
    );
    expect(onOpen).toHaveBeenLastCalledWith('wiki/z.md');
    await userEvent.click(screen.getByRole('button', { name: /Next chapter/ }));
    expect(onOpen).toHaveBeenLastCalledWith('wiki/last.md');
    mid.unmount();

    render(
      chapter({
        index: 0,
        path: 'wiki/z.md',
        book: { chapters: [book.chapters[0]] },
      }),
    );
    await screen.findByText('Intro zero.');
    expect(
      screen.queryByRole('button', { name: /Previous chapter/ }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /Next chapter/ })).toBeNull();
  });

  it("lists the sections in the rail, with the reading section's sources, linked from and Mark verified", async () => {
    fake();
    const onOpen = vi.fn();
    render(chapter({ onOpen, path: 'wiki/two.md' }));
    await screen.findByText('Partners.');
    const rail = screen.getByRole('complementary');
    const outline = within(rail).getByRole('region', {
      name: 'In this chapter',
    });
    expect(
      within(outline)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Overview', 'Order flow', 'Integrations']);
    expect(
      within(rail).getByRole('region', { name: 'Linked from' }),
    ).toBeTruthy();
    expect(
      within(rail).getByRole('button', { name: 'Mark verified' }),
    ).toBeTruthy();
  });

  it('marks the section verified with its raw text and refetches', async () => {
    const { calls } = fake();
    render(chapter({ path: 'wiki/two.md' }));
    await screen.findByText('Partners.');
    await userEvent.click(
      screen.getByRole('button', { name: 'Mark verified' }),
    );
    expect(calls.find((c) => c.channel === 'brain:verify')!.args).toEqual([
      'b1',
      'wiki/two.md',
    ]);
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'brain:read')).toHaveLength(6),
    );
  });

  it('shows a one-line error for a page that fails to read, the rest still show', async () => {
    fake({
      'brain:read': (_id, rel) => {
        if (rel === 'wiki/two.md') throw new Error('disk gone');
        return { text: text(rel) };
      },
    });
    render(chapter());
    expect(await screen.findByText(/disk gone/)).toBeTruthy();
    expect(screen.getByText('Partners.')).toBeTruthy();
    expect(screen.getByText('Order flow', { selector: 'h2' })).toBeTruthy();
  });

  it('follows the scroll: the rail highlights the section being read and reports it', async () => {
    fake();
    const onReading = vi.fn();
    const { container } = render(
      <div className="brain-read-main">{chapter({ onReading })}</div>,
    );
    await screen.findByText('Partners.');
    const main = container.querySelector('.brain-read-main')!;
    main.getBoundingClientRect = () => ({ top: 0, height: 900 }) as DOMRect;
    const tops = [-500, -100, 800];
    container
      .querySelectorAll('section[data-path]')
      .forEach(
        (s, i) =>
          (s.getBoundingClientRect = () => ({ top: tops[i] }) as DOMRect),
      );
    act(() => {
      main.dispatchEvent(new Event('scroll'));
    });
    expect(onReading).toHaveBeenLastCalledWith('wiki/two.md');
    expect(
      within(screen.getByRole('complementary'))
        .getByRole('link', { name: 'Order flow' })
        .getAttribute('aria-current'),
    ).toBe('location');
  });

  it('shows the new chapter, not the old texts, when the chapter changes to one with more pages', async () => {
    fake();
    const small: BrainBook = {
      chapters: [
        book.chapters[2],
        { ...book.chapters[2], pages: ['wiki/three.md'] },
      ],
    };
    const view = render(
      chapter({ book: small, index: 1, path: 'wiki/three.md' }),
    );
    await screen.findByText('Partners.');
    view.rerender(chapter({ book: small, index: 0, path: 'wiki/one.md' }));
    expect(screen.queryByText('Partners.')).toBeNull();
    expect(await screen.findByText('Orders move.')).toBeTruthy();
    expect(screen.getByText('Order flow', { selector: 'h2' })).toBeTruthy();
  });

  it('keeps the sections on screen, and does not scroll, when a page is added to the chapter', async () => {
    fake();
    const view = render(chapter({ path: 'wiki/two.md' }));
    await screen.findByText('Partners.');
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    scrolled.mockReset();
    const added: BrainBook = {
      chapters: book.chapters.map((c, i) =>
        i === 2 ? { ...c, pages: [...c.pages, 'wiki/four.md'] } : c,
      ),
    };
    view.rerender(chapter({ book: added, path: 'wiki/two.md' }));
    expect(screen.queryByText('Loading')).toBeNull();
    expect(screen.getByText('Orders move.')).toBeTruthy();
    await waitFor(() =>
      expect(
        document.querySelector('section[data-path="wiki/four.md"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByText('Loading')).toBeNull();
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('keeps the sections, and does not scroll, when the chapters are reordered around the open one', async () => {
    fake();
    const view = render(chapter({ path: 'wiki/two.md' }));
    await screen.findByText('Partners.');
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    scrolled.mockReset();
    const reordered: BrainBook = {
      chapters: [
        { title: 'New', summary: '', intro: '', pages: ['wiki/n.md'] },
        ...book.chapters,
      ],
    };
    view.rerender(chapter({ book: reordered, index: 3, path: 'wiki/two.md' }));
    expect(screen.queryByText('Loading')).toBeNull();
    expect(screen.getByText('Partners.')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Partners.')).toBeTruthy());
    expect(screen.queryByText('Loading')).toBeNull();
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('refetches on a brain change without scrolling', async () => {
    const { emit, calls } = fake();
    render(chapter({ path: 'wiki/two.md' }));
    await screen.findByText('Partners.');
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    scrolled.mockReset();
    const before = calls.filter((c) => c.channel === 'brain:read').length;
    vi.useFakeTimers();
    act(() => emit('brain:changed', { brainId: 'b1' } as never));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(calls.filter((c) => c.channel === 'brain:read').length).toBe(
      before + 3,
    );
    expect(scrolled).not.toHaveBeenCalled();
  });
});
