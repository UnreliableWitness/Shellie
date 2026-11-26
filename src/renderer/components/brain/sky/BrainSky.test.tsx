import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainBook, BrainPageRow } from '../../../../shared/brain';
import { installFakeApi } from '../../../test-helpers/fakeApi';
import type { BrainPages } from '../BrainWiki';
import { BrainSky } from './BrainSky';
import type { SkyFocus, SkyHandlers, SkyScene } from './SkyScene';
import type { Sky } from './skyLayout';

/** A scene that draws nothing and remembers what it was told. */
class FakeScene {
  static made: FakeScene[] = [];
  static fail = false;
  calls: string[] = [];
  sky: Sky | null = null;
  focus: SkyFocus | null = null;
  running = false;
  constructor(
    _host: HTMLElement,
    readonly handlers: SkyHandlers,
  ) {
    if (FakeScene.fail) throw new Error('Error creating WebGL context');
    FakeScene.made.push(this);
  }
  setSky(sky: Sky, keep?: { camera: boolean }) {
    this.sky = sky;
    this.calls.push(keep?.camera ? 'setSky keep' : 'setSky');
  }
  setFocus(focus: SkyFocus) {
    this.focus = focus;
  }
  flyToStar(star: number) {
    this.calls.push(`fly ${this.sky!.stars[star].title}`);
  }
  flyToOverview() {
    this.calls.push('overview');
  }
  setPanelWidth() {}
  setRunning(on: boolean) {
    this.running = on;
  }
  dispose() {
    this.calls.push('dispose');
  }
}
const scene = () => FakeScene.made[FakeScene.made.length - 1];
const loadScene = () =>
  Promise.resolve({ SkyScene: FakeScene as unknown as typeof SkyScene });

const row = (name: string, over: Partial<BrainPageRow> = {}): BrainPageRow => ({
  path: `wiki/${name.toLowerCase()}.md`,
  title: name,
  summary: '',
  type: 'component',
  lastUpdated: '2020-01-01',
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
  pictures: [],
  ...over,
});
const ROWS = [
  row('Checkout', {
    summary: 'How paying works',
    linkedFrom: ['wiki/cart.md', 'wiki/refunds.md'],
  }),
  row('Cart'),
  row('Refunds', { linkedFrom: ['wiki/cart.md'] }),
  row('Mission', { type: 'subject' }),
];
const BOOK: BrainBook = {
  chapters: [
    {
      title: 'The project',
      summary: '',
      intro: '',
      pages: ['wiki/mission.md'],
    },
    {
      title: 'The shop',
      summary: '',
      intro: '',
      pages: ['wiki/checkout.md', 'wiki/cart.md', 'wiki/refunds.md'],
    },
  ],
};
const pagesOf = (rows = ROWS, book: BrainBook | null = BOOK): BrainPages => ({
  rows,
  sources: [
    {
      path: 'sources/note.md',
      type: 'note',
      ingestedAt: '2026-11-01T10:00:00Z',
      captured: true,
      original: null,
      contents: null,
      note: null,
    },
  ],
  log: '',
  book,
  reads: { reads: [], letters: [] },
  loaded: true,
});
const TEXT: Record<string, string> = {
  'wiki/checkout.md':
    '# Checkout\n\nSee the [Cart page](cart.md) and the [note](../sources/note.md).\n',
};

const onOpenInRead = vi.fn();
async function show(pages = pagesOf(), active = true, wait = active) {
  const api = installFakeApi({
    'brain:read': (_id, rel) => ({ text: TEXT[rel] ?? `# ${rel}\n\nText.\n` }),
  });
  const props = {
    brainId: 'b1',
    brainName: 'Acme',
    since: null,
    onOpenInRead,
    loadScene,
  };
  const view = render(<BrainSky {...props} pages={pages} active={active} />);
  if (wait && !FakeScene.fail)
    await waitFor(() => expect(scene()?.sky ?? null).not.toBeNull());
  return {
    api,
    rerender: (next: BrainPages, on = true) =>
      view.rerender(<BrainSky {...props} pages={next} active={on} />),
    unmount: view.unmount,
  };
}
const panel = () => screen.getByRole('complementary');
const star = (title: string) =>
  scene().sky!.stars.findIndex((s) => s.title === title);
const pick = (title: string) => act(() => scene().handlers.onPick(star(title)));
/** The open page's headings by that name: its title, and the text's own first heading. */
const reading = (name: string) =>
  within(panel()).findAllByRole('heading', { name });
const search = () => screen.getByRole('searchbox', { name: 'Find a page' });

beforeEach(() => {
  FakeScene.made = [];
  FakeScene.fail = false;
  onOpenInRead.mockClear();
});

describe('BrainSky', () => {
  it('shows the brain at a glance: pages, clusters, the three facts, most linked', async () => {
    await show();
    const p = within(panel());
    expect(
      p.getByRole('heading', { name: '4 pages in 2 clusters' }),
    ).toBeInTheDocument();
    expect(p.getByText('Links').nextElementSibling).toHaveTextContent('3');
    expect(
      p.getByText('Changed in 14 days').nextElementSibling,
    ).toHaveTextContent('0');
    expect(
      p.getByText('Untouched for 4 months').nextElementSibling,
    ).toHaveTextContent('4');
    const most = within(p.getByRole('list', { name: 'Most linked' }));
    expect(most.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Checkout',
      'Cart',
      'Refunds',
      'Mission',
    ]);
    expect(scene().calls).toEqual(['setSky']);
  });

  it('an empty brain shows zeros and makes a scene without error', async () => {
    await show(pagesOf([], null));
    expect(
      within(panel()).getByRole('heading', { name: '0 pages in 0 clusters' }),
    ).toBeInTheDocument();
    expect(scene().sky!.stars).toEqual([]);
  });

  it('a picked star opens its page in the panel, flies to it and joins the trail', async () => {
    const { api } = await show();
    pick('Checkout');
    expect(await reading('Checkout')).not.toHaveLength(0);
    expect(scene().calls).toContain('fly Checkout');
    expect(scene().focus!.selected).toBe(star('Checkout'));
    expect(api.tracked).toContainEqual(
      expect.objectContaining({
        name: 'brain.screen.action',
        props: { action: 'open-page', origin: 'sky' },
      }),
    );
    // One page is not a trail yet.
    expect(screen.queryByRole('navigation', { name: 'Trail' })).toBeNull();
    pick('Mission');
    const trail = within(screen.getByRole('navigation', { name: 'Trail' }));
    expect(trail.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Checkout',
      'Mission',
    ]);
    expect(trail.getByRole('button', { name: 'Mission' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await userEvent.click(trail.getByRole('button', { name: 'Checkout' }));
    expect(scene().focus!.selected).toBe(star('Checkout'));
  });

  it('a link in the page to another page flies there; a link to a source opens it and does not fly', async () => {
    await show();
    pick('Checkout');
    await userEvent.click(
      await within(panel()).findByRole('link', { name: 'Cart page' }),
    );
    expect(scene().calls).toContain('fly Cart');
    expect(scene().focus!.selected).toBe(star('Cart'));
    // Back to Checkout, then to the source.
    await userEvent.click(
      within(panel()).getByRole('button', { name: 'Back' }),
    );
    expect(scene().focus!.selected).toBe(star('Checkout'));
    const flights = scene().calls.length;
    await userEvent.click(
      await within(panel()).findByRole('link', { name: 'note' }),
    );
    await waitFor(() => expect(scene().focus!.selected).toBeNull());
    expect(scene().calls).toHaveLength(flights);
  });

  it('a long read goes to the Read view', async () => {
    TEXT['wiki/cart.md'] = '# Cart\n\n[The long one](../reads/shop.md)\n';
    await show();
    pick('Cart');
    await userEvent.click(
      await within(panel()).findByRole('link', { name: 'The long one' }),
    );
    expect(onOpenInRead).toHaveBeenCalledWith('reads/shop.md');
    expect(scene().focus!.selected).toBe(star('Cart'));
    delete TEXT['wiki/cart.md'];
  });

  it('search lights the matches, says how many, and Enter opens the best', async () => {
    await show();
    pick('Mission');
    await userEvent.type(search(), 'compo');
    expect(screen.getByText('3 found')).toBeInTheDocument();
    expect([...scene().focus!.matches!].sort()).toEqual(
      [star('Cart'), star('Checkout'), star('Refunds')].sort(),
    );
    // A search looks at the whole brain: the open page closes.
    expect(scene().focus!.selected).toBeNull();
    expect(scene().calls[scene().calls.length - 1]).toBe('overview');
    await userEvent.keyboard('{Enter}');
    expect(scene().focus!.selected).toBe(star('Cart'));
    expect(scene().focus!.matches).toBeNull();
    expect(search()).toHaveValue('');
  });

  it('Left and Right pick a neighbour, Enter opens it, Escape closes', async () => {
    await show();
    pick('Checkout');
    await userEvent.keyboard('{ArrowRight}');
    expect(scene().focus!.candidate).toBe(star('Cart'));
    await userEvent.keyboard('{ArrowRight}');
    expect(scene().focus!.candidate).toBe(star('Refunds'));
    await userEvent.keyboard('{ArrowLeft}{Enter}');
    expect(scene().focus!.selected).toBe(star('Cart'));
    expect(scene().focus!.candidate).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(scene().focus!.selected).toBeNull();
    expect(scene().calls[scene().calls.length - 1]).toBe('overview');
  });

  it('the keys leave typing alone, and Escape in the search field clears it first', async () => {
    await show();
    pick('Checkout');
    await userEvent.keyboard('/');
    expect(search()).toHaveFocus();
    pick('Checkout');
    await userEvent.keyboard('{ArrowRight}{Enter}');
    expect(scene().focus!.candidate).toBeNull();
    expect(scene().focus!.selected).toBe(star('Checkout'));
    await userEvent.type(search(), 'zz');
    expect(screen.getByText('0 found')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(search()).toHaveValue('');
    expect(scene().focus!.matches).toBeNull();
  });

  it('leaves Ctrl+K to a terminal and to another field', async () => {
    await show();
    const terminal = document.createElement('div');
    terminal.className = 'brain-terminal';
    const shell = document.createElement('textarea');
    terminal.appendChild(shell);
    document.body.appendChild(terminal);
    shell.focus();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(shell).toHaveFocus();
    shell.blur();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(search()).toHaveFocus();
    terminal.remove();
  });

  it('leaves a key that a menu or a dialog already took', async () => {
    await show();
    pick('Checkout');
    // A menu closed itself on this Escape: the page behind it stays open.
    const taken = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    taken.preventDefault();
    act(() => void document.body.dispatchEvent(taken));
    expect(scene().focus!.selected).toBe(star('Checkout'));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();
    await userEvent.keyboard('{ArrowRight}{Escape}');
    expect(scene().focus!.candidate).toBeNull();
    expect(scene().focus!.selected).toBe(star('Checkout'));
    dialog.remove();
  });

  it('forgets the picked neighbour when the page changes or the brain does', async () => {
    const view = await show();
    pick('Checkout');
    await userEvent.keyboard('{ArrowRight}');
    expect(scene().focus!.candidate).toBe(star('Cart'));
    await userEvent.click(
      within(panel()).getByRole('button', { name: 'Whole brain' }),
    );
    expect(scene().focus!.candidate).toBeNull();
    pick('Checkout');
    await userEvent.keyboard('{ArrowRight}');
    act(() => scene().handlers.onHover(star('Mission')));
    view.rerender(pagesOf(ROWS.slice(0, 2)));
    await waitFor(() => expect(scene().sky!.stars).toHaveLength(2));
    expect(scene().focus!.candidate).toBeNull();
    expect(scene().focus!.hovered).toBeNull();
    // Enter has nothing to open, and nothing breaks.
    await userEvent.keyboard('{Enter}');
    expect(scene().focus!.selected).toBe(star('Checkout'));
  });

  it('Open in Read asks for the Read view on that page', async () => {
    await show();
    pick('Refunds');
    await userEvent.click(
      within(panel()).getByRole('button', { name: 'Open in Read' }),
    );
    expect(onOpenInRead).toHaveBeenCalledWith('wiki/refunds.md');
  });

  it('makes no scene until it is in front, runs only while it is, and disposes on unmount', async () => {
    const view = await show(pagesOf(), false);
    await act(() => Promise.resolve());
    expect(FakeScene.made).toHaveLength(0);
    view.rerender(pagesOf(), true);
    await waitFor(() => expect(scene()?.running).toBe(true));
    view.rerender(pagesOf(), false);
    expect(scene().running).toBe(false);
    // Paused, not thrown away: the camera and the selection are there on the way back.
    expect(scene().calls).not.toContain('dispose');
    view.rerender(pagesOf(), true);
    expect(scene().running).toBe(true);
    expect(FakeScene.made).toHaveLength(1);
    view.unmount();
    expect(scene().calls).toContain('dispose');
  });

  it('a brain that changes keeps the camera; the open page disappearing returns to the brain at a glance', async () => {
    const view = await show();
    pick('Refunds');
    view.rerender(pagesOf([...ROWS, row('New')]));
    await waitFor(() => expect(scene().sky!.stars).toHaveLength(5));
    expect(scene().calls).toContain('setSky keep');
    expect(scene().focus!.selected).toBe(star('Refunds'));
    view.rerender(pagesOf(ROWS.filter((r) => r.title !== 'Refunds')));
    expect(
      await within(panel()).findByRole('heading', {
        name: '3 pages in 2 clusters',
      }),
    ).toBeInTheDocument();
    expect(scene().focus!.selected).toBeNull();
  });

  it('waits for the pages before the first sky, so the flight in shows the real brain', async () => {
    const view = await show(
      { ...pagesOf([], null), loaded: false },
      true,
      false,
    );
    await waitFor(() => expect(FakeScene.made).toHaveLength(1));
    await act(() => Promise.resolve());
    expect(scene()?.sky ?? null).toBeNull();
    view.rerender(pagesOf());
    await waitFor(() => expect(scene().calls).toEqual(['setSky']));
  });

  it('without WebGL it shows the flat map with the same panel', async () => {
    FakeScene.fail = true;
    await show();
    expect(
      await screen.findByText(/3D view is not available on this machine/),
    ).toBeInTheDocument();
    const map = screen.getByRole('region', { name: 'How pages link' });
    await userEvent.click(
      within(map).getByRole('button', { name: 'Checkout' }),
    );
    expect(await reading('Checkout')).not.toHaveLength(0);
  });

  it('a scene that loses its graphics for good gives way to the flat map', async () => {
    await show();
    act(() => scene().handlers.onLost());
    expect(
      await screen.findByRole('region', { name: 'How pages link' }),
    ).toBeInTheDocument();
    expect(scene().calls).toContain('dispose');
  });
});
