import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { b64url, ReaderMarksSchema, unseal } from '../../../src/shared/reader';
import { App } from './App';
import { memoryStore, type ItemStore } from './cache';
import { loadPlaces, savePlace, SECRET_KEY, storeSecret } from './local';
import {
  fakeServer,
  LINK,
  SECRET,
  seedBakery,
  type FakeServer,
} from './testing';

let server: FakeServer;
let store: ItemStore;

beforeEach(async () => {
  server = await fakeServer();
  store = memoryStore();
});

/** The site on a phone that already holds the secret. */
function connected() {
  storeSecret(SECRET);
  return render(<App fetcher={server.fetcher} store={store} />);
}

const click = (name: string | RegExp, role = 'button') =>
  fireEvent.click(screen.getByRole(role, { name }));

/** The site with the bakery's reading list on screen. */
async function onList() {
  const seeded = await seedBakery(server);
  const view = connected();
  await screen.findByRole('heading', { level: 1, name: 'Corner Bakery' });
  return { ...seeded, ...view };
}

/** Opens a piece from the list and waits for its text. */
async function openPiece(title: string | RegExp, text: string | RegExp) {
  click(title);
  await screen.findByText(text);
}

describe('connecting', () => {
  it('asks for the link, refuses what is none and takes a pasted one', async () => {
    await seedBakery(server);
    render(<App fetcher={server.fetcher} store={store} />);
    expect(screen.getByText(/Open the link from Shellie:/)).toBeInTheDocument();
    expect(screen.getByText('Settings › User › Phone')).toBeInTheDocument();
    expect(server.calls).toHaveLength(0);

    const field = screen.getByLabelText('The link from Shellie');
    fireEvent.change(field, {
      target: { value: 'https://reader.example/#not-the-secret' },
    });
    click('Connect');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That is not a link from Shellie.',
    );
    expect(localStorage.getItem(SECRET_KEY)).toBeNull();
    expect(server.calls).toHaveLength(0);

    fireEvent.change(field, { target: { value: LINK } });
    expect(screen.queryByRole('alert')).toBeNull();
    click('Connect');
    await screen.findByRole('heading', { level: 1, name: 'Corner Bakery' });
    expect(localStorage.getItem(SECRET_KEY)).toBe(b64url(SECRET));
  });

  it('takes the secret from a link opened in the page that is already open', async () => {
    await seedBakery(server);
    render(<App fetcher={server.fetcher} store={store} />);
    act(() => {
      history.replaceState(null, '', `/#${b64url(SECRET)}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await screen.findByRole('heading', { level: 1, name: 'Corner Bakery' });
    expect(window.location.hash).toBe('');
  });

  it('never sends the secret, and asks only its own server', async () => {
    await onList();
    await waitFor(() => expect(server.count('GET p')).toBe(2));
    const secret = b64url(SECRET);
    for (const call of server.calls) {
      expect(call.path.startsWith('/api/v1/items')).toBe(true);
      expect(call.path).not.toContain(secret);
      expect(call.headers.get('Authorization')).toBe(
        `Bearer ${server.keys.reader}.${server.keys.token}`,
      );
      expect(call.headers.get('Authorization')).not.toContain(secret);
    }
  });

  it('says so when the server no longer knows this phone, and forgets it when asked', async () => {
    await onList();
    await waitFor(async () =>
      expect((await store.index()).length).toBe(server.items.size),
    );
    savePlace('r-1', 0.5);
    server.mode = 401;
    click('Menu');
    click('Check for new pieces', 'menuitem');
    await screen.findByText(
      'This phone is no longer connected. Open the link from Shellie again.',
    );

    click('Forget this phone');
    const dialog = screen.getByRole('alertdialog', {
      name: 'Forget this phone?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(localStorage.getItem(SECRET_KEY)).not.toBeNull();

    click('Forget this phone');
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Forget this phone',
      }),
    );
    await screen.findByRole('heading', { name: 'Connect this phone' });
    expect(localStorage.getItem(SECRET_KEY)).toBeNull();
    expect(loadPlaces()).toEqual({});
    expect(await store.index()).toEqual([]);
  });

  it('shows what was kept, and says it is offline, without a connection', async () => {
    const first = await onList();
    await waitFor(async () =>
      expect((await store.index()).length).toBe(server.items.size),
    );
    first.unmount();

    server.mode = 'offline';
    render(<App fetcher={server.fetcher} store={store} />);
    await screen.findByRole('heading', { level: 1, name: 'Corner Bakery' });
    await screen.findByText('Offline: showing what was kept');
    await openPiece(/The baking plan/, /turns the day's orders into one plan/);
  });

  it('says that nothing was sent when the server holds no shelf', async () => {
    connected();
    await screen.findByText(
      'Nothing was sent yet. In Shellie, switch on “Send long reads and letters to my phone” for a brain.',
    );
  });

  it('offers to try again when the server fails', async () => {
    server.mode = 500;
    connected();
    await screen.findByText(/The server could not be asked for new pieces/);
    await seedBakery(server);
    server.mode = 'ok';
    click('Try again');
    await screen.findByRole('heading', { level: 1, name: 'Corner Bakery' });
    expect(screen.queryByText(/could not be asked/)).toBeNull();
  });
});

describe('the reading list', () => {
  it('shows the sections of a shelf, the progress and what is left', async () => {
    await onList();
    expect(screen.getByText('Shellie Reader')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: '3 of 7 read' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('3 of 7 read · about 28 min left'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'For your work this sprint' }),
    ).toBeNull();

    const changed = screen.getByRole('region', {
      name: 'Changed since you read it',
    });
    const changes = within(changed).getAllByRole('button');
    expect(changes).toHaveLength(2);
    // The newest first: the letter of 9 Nov, then the long read no letter was written for.
    expect(changes[0]).toHaveTextContent('The rounds leave earlier');
    expect(changes[0]).toHaveTextContent('A letter about The delivery rounds');
    expect(changes[0]).toHaveTextContent('Letter · 3 min · 9 Nov');
    expect(changes[1]).toHaveTextContent('Where a price comes from');
    expect(within(changes[1]).getByText('Changed')).toBeInTheDocument();

    const foundations = screen.getByRole('region', {
      name: 'Foundations, in order',
    });
    expect(within(foundations).getByText('3 of 4')).toBeInTheDocument();
    const inOrder = within(foundations)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(inOrder).toHaveLength(4);
    expect(inOrder[0]).toBe('How an order is taken, read');
    expect(inOrder[1]).toBe('Where a price comes from, read');
    expect(inOrder[2]).toContain('The baking plan');
    expect(inOrder[2]).toContain(
      'How a day of orders becomes one night of baking.',
    );
    expect(inOrder[2]).toContain('Long read · 11 min · 3 Nov');
    expect(inOrder[2]).toContain(
      'Pages under it changed; Shellie can bring it up to date',
    );
    expect(inOrder[3]).toBe('The delivery rounds, read');

    // Later is closed, with its count in the heading.
    const later = screen.getByRole('button', { name: /Later/ });
    expect(later).toHaveTextContent('1 piece');
    expect(later).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Standing orders')).toBeNull();
    fireEvent.click(later);
    expect(
      screen.getByText('Orders that repeat every week.'),
    ).toBeInTheDocument();
  });

  it('shows the sprint section, how far a piece was read, and a brain without long reads', async () => {
    const { shelf } = await seedBakery(server);
    const plan = shelf.reads[1];
    await server.put(await server.id('m'), {
      ...shelf,
      reads: shelf.reads.map((r) =>
        r === plan
          ? { ...r, work: [{ id: 412, title: 'Print the plan per oven' }] }
          : r,
      ),
    });
    savePlace(plan.id, 0.4);
    const view = connected();
    const work = await screen.findByRole('region', {
      name: 'For your work this sprint',
    });
    const entry = within(work).getByRole('button');
    expect(entry).toHaveTextContent('#412 Print the plan per oven');
    expect(entry).toHaveTextContent('Long read · 11 min · 3 Nov · 40% read');
    view.unmount();

    await server.put(await server.id('m'), {
      ...shelf,
      reads: [],
      letters: [],
      refs: {},
    });
    render(<App fetcher={server.fetcher} store={memoryStore()} />);
    await screen.findByText(
      'Nothing to read yet. Long reads are written in Shellie: Brain › Read › Long reads.',
    );
  });

  it('switches between brains, remembers the choice, and falls back when the brain is gone', async () => {
    const { shelf } = await seedBakery(server);
    const other = 'm-' + 'c'.repeat(32);
    await server.put(other, {
      ...shelf,
      brainId: 'brain-mill',
      name: 'The Mill',
      reads: [],
      letters: [],
      refs: {},
    });
    const view = connected();
    await screen.findByRole('heading', { level: 1, name: 'Corner Bakery' });
    click('Switch brain');
    click('The Mill', 'menuitem');
    await screen.findByRole('heading', { level: 1, name: 'The Mill' });
    view.unmount();

    const again = render(<App fetcher={server.fetcher} store={store} />);
    await screen.findByRole('heading', { level: 1, name: 'The Mill' });
    again.unmount();

    server.items.delete(other);
    render(<App fetcher={server.fetcher} store={store} />);
    await screen.findByRole('heading', { level: 1, name: 'Corner Bakery' });
    expect(screen.queryByRole('button', { name: 'Switch brain' })).toBeNull();
  });
});

describe('a long read', () => {
  it('holds the answer back until it is asked for, and keeps the gaps closed', async () => {
    await onList();
    await openPiece(/The baking plan/, /turns the day's orders into one plan/);
    expect(
      screen.getByRole('heading', { level: 1, name: 'The baking plan' }),
    ).toBeInTheDocument();
    // The address says nothing about the piece.
    expect(window.location.pathname + window.location.hash).toBe('/');
    expect(screen.getByText('about 11 min left')).toBeInTheDocument();

    const question = screen.getByRole('complementary', {
      name: 'Before you read on',
    });
    expect(question).toHaveTextContent(
      'An order comes in after the plan was made.',
    );
    expect(screen.queryByText(/goes on tomorrow's sheet/)).toBeNull();
    click('Show the answer');
    const answer = screen.getByText(/goes on tomorrow's sheet/);
    expect(question).toContainElement(answer);
    expect(document.activeElement).toBe(answer.closest('.answer'));
    expect(
      screen.queryByRole('button', { name: 'Show the answer' }),
    ).toBeNull();

    const missing = screen
      .getByText('What the writer was missing')
      .closest('details');
    expect(missing).not.toHaveAttribute('open');
    expect(missing).toHaveTextContent(
      'Nobody said who may change the plan after midnight.',
    );
    // The title is the page's heading, not a second one in the text.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows a picture as its description and opens a web link in a new tab', async () => {
    await onList();
    await openPiece(/The baking plan/, /turns the day's orders into one plan/);
    expect(document.querySelector('img')).toBeNull();
    expect(
      screen.getByRole('img', { name: 'The plan on the wall' }),
    ).toHaveTextContent('Picture: The plan on the wall');
    const web = screen.getByRole('link', { name: "miller's site" });
    expect(web).toHaveAttribute('href', 'https://example.com/mill');
    expect(web).toHaveAttribute('target', '_blank');
    expect(web).toHaveAttribute('rel', 'noreferrer noopener');
    // A path in the brain is never an address the browser could ask for.
    expect(screen.getByRole('link', { name: 'order sheet' })).toHaveAttribute(
      'href',
      '#',
    );
  });

  it('marks the piece as read on the server, and unread again', async () => {
    const { shelf } = await onList();
    const plan = shelf.reads[1];
    await openPiece(/The baking plan/, /turns the day's orders into one plan/);
    click('Mark as read');
    await screen.findByRole('button', { name: 'Mark unread' });
    const id = await server.id('k');
    const marksNow = async () =>
      ReaderMarksSchema.parse(
        await unseal(server.keys, id, server.items.get(id)!.bytes),
      ).marks;
    await waitFor(async () =>
      expect((await marksNow())[plan.path]).toMatchObject({
        hash: plan.hash,
        read: true,
      }),
    );

    click('Reading list');
    await screen.findByText('4 of 7 read · about 17 min left');
    const foundations = screen.getByRole('region', {
      name: 'Foundations, in order',
    });
    expect(within(foundations).getByText('4 of 4')).toBeInTheDocument();

    click(/The baking plan/);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark unread' }));
    await screen.findByRole('button', { name: 'Mark as read' });
    await waitFor(async () =>
      expect((await marksNow())[plan.path].read).toBe(false),
    );
  });

  it('opens another piece from a link, and goes back with the browser', async () => {
    await onList();
    await openPiece(/The baking plan/, /turns the day's orders into one plan/);
    click('the delivery rounds', 'link');
    await screen.findByText('Two rounds leave each morning.');
    expect(
      screen.getByRole('heading', { level: 1, name: 'The delivery rounds' }),
    ).toBeInTheDocument();
    // Its newest letter is one tap away.
    click('The rounds leave earlier');
    await screen.findByText('The second round leaves at half past six.');

    act(() => history.back());
    await screen.findByText('Two rounds leave each morning.');
    click('Reading list');
    await screen.findByRole('heading', { level: 1, name: 'Corner Bakery' });
  });

  it('says so when a piece is not kept and cannot be fetched', async () => {
    await seedBakery(server);
    const real = server.fetcher;
    let down = false;
    storeSecret(SECRET);
    render(
      <App
        fetcher={async (input, init) => {
          if (down || String(input).includes('/items/r-'))
            throw new TypeError('Failed to fetch');
          return real(input, init);
        }}
        store={store}
      />,
    );
    await screen.findByRole('heading', { level: 1, name: 'Corner Bakery' });
    down = true;
    click(/The baking plan/);
    await screen.findByText(/This piece is not kept on this phone yet/);
    expect(screen.queryByRole('button', { name: 'Mark as read' })).toBeNull();
  });
});

describe('a letter', () => {
  it('shows its labelled sections, what was read struck through, and the long read it is about', async () => {
    await onList();
    await openPiece(
      /The rounds leave earlier/,
      'The second round leaves at half past six.',
    );
    expect(
      screen.getByText(/The second round moved, and with it/),
    ).toBeInTheDocument();
    const labels = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(labels).toEqual([
      'What you read',
      'What holds now',
      'Why it changed',
      'What follows',
    ]);
    const was = screen.getByRole('group', { name: 'What you read' });
    expect(was).toHaveClass('told', 'is-read');
    expect(was).toHaveTextContent('The second round leaves at seven.');

    click('Mark as read');
    await screen.findByRole('button', { name: 'Mark unread' });
    click('The delivery rounds');
    await screen.findByText('Two rounds leave each morning.');
  });
});

describe('a link to a page of the brain', () => {
  it('opens a kept page over the piece at the heading, and steps back through the pages opened in it', async () => {
    await onList();
    await openPiece(/The baking plan/, /turns the day's orders into one plan/);
    const scrolled = Element.prototype.scrollIntoView as unknown as {
      mock: { instances: Element[] };
      mockClear(): void;
    };
    scrolled.mockClear();
    click('order sheet', 'link');
    const sheet = await screen.findByRole('dialog', { name: 'Order sheet' });
    await within(sheet).findByText('One sheet per day, kept at the counter.');
    // Scrolled to the heading the link named; the sheet's ids are its own.
    await waitFor(() =>
      expect(scrolled.mock.instances.map((el) => el.id)).toContain(
        'ref-cut-off-time',
      ),
    );
    // The piece stays under it.
    expect(
      screen.getByText(/turns the day's orders into one plan/),
    ).toBeInTheDocument();
    expect(window.location.pathname + window.location.hash).toBe('/');

    // A link in the sheet replaces its content.
    fireEvent.click(within(sheet).getByRole('link', { name: 'oven schedule' }));
    await screen.findByRole('dialog', { name: 'Oven schedule' });
    await screen.findByText('The oven is lit at two.');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    // Back steps back one page; closing leaves the sheet whatever was opened in it.
    act(() => history.back());
    await screen.findByRole('dialog', { name: 'Order sheet' });
    // The page's text is read from what is kept, a moment after its title shows.
    fireEvent.click(
      await within(screen.getByRole('dialog')).findByRole('link', {
        name: 'oven schedule',
      }),
    );
    await screen.findByRole('dialog', { name: 'Oven schedule' });
    click('Close');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      screen.getByRole('heading', { level: 1, name: 'The baking plan' }),
    ).toBeInTheDocument();
  });

  it('says that a page was not sent to the phone', async () => {
    await onList();
    await openPiece(/The baking plan/, /turns the day's orders into one plan/);
    const before = server.calls.length;
    click('supplier list', 'link');
    const sheet = await screen.findByRole('dialog', {
      name: 'Not on your phone',
    });
    expect(sheet).toHaveTextContent(
      'This page was not sent to your phone. Open it in Shellie.',
    );
    // Nothing was asked of the server for it: the path stays on the phone.
    expect(server.calls.length).toBe(before);
    click('Close');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
