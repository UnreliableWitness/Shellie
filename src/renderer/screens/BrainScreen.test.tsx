import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainSourceRow } from '../../shared/brain';
import { useStore } from '../store';
import { installFakeApi, type FakeHandlers } from '../test-helpers/fakeApi';
import { brainJob, brainView } from '../test-helpers/brainFixture';
import { BrainScreen } from './BrainScreen';

vi.mock('../components/TerminalView', () => ({
  TerminalView: (p: { terminalId: string; taskId: string }) => (
    <div data-testid="terminal">{`${p.taskId}/${p.terminalId}`}</div>
  ),
}));

const def = { id: 'bt1', kind: 'claude' as const, label: 'Brain' };
const setup = (brain = brainView(), over: FakeHandlers = {}) =>
  installFakeApi({
    'brain:get': () => brain,
    'brain:run': (brainId, kind) => brainJob({ brainId, kind }),
    'brain:terminal': () => def,
    'terminals:write': () => undefined,
    ...over,
  });
const names = (a: { calls: { channel: string }[] }) =>
  a.calls.map((c) => c.channel);
/** Switches to the Add view (Run now, Health, the inbox) and returns its Run now card. */
const openAdd = async () => {
  await userEvent.click(await screen.findByRole('tab', { name: /^Add/ }));
  return within(screen.getByRole('region', { name: 'Run now' }));
};
const page = (path: string, title: string) => ({
  path,
  title,
  summary: '',
  type: 'other' as const,
  lastUpdated: null,
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
});
const source = (path: string): BrainSourceRow => ({
  path,
  type: 'doc',
  ingestedAt: '2026-11-04T09:00:00.000Z',
  captured: false,
  original: null,
  contents: null,
  note: null,
});

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ notices: [], screen: { kind: 'brain', brainId: 'b1' } });
});

describe('BrainScreen', () => {
  it('shows the brain name, health and the inbox', async () => {
    setup();
    render(<BrainScreen brainId="b1" />);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.getByText(/2 findings/)).toBeInTheDocument();
    expect(screen.getByText(/Drop files here/)).toBeInTheDocument();
    expect(screen.getByText(/3 uncaptured/)).toBeInTheDocument();
    expect(screen.getByText(/12 pages/)).toBeInTheDocument();
  });

  it('Lint button queues a lint', async () => {
    const a = setup();
    render(<BrainScreen brainId="b1" />);
    await userEvent.click(
      (await openAdd()).getByRole('button', { name: 'Lint' }),
    );
    expect(a.calls).toContainEqual({
      channel: 'brain:run',
      args: ['b1', 'lint'],
    });
    expect(a.tracked).toContainEqual(
      expect.objectContaining({
        name: 'brain.screen.action',
        props: { action: 'lint' },
      }),
    );
  });

  it('Digest and Refresh wiki call their channels', async () => {
    const wiki = {
      wikiId: 'w1',
      wikiName: 'Shellie.wiki',
      type: 'projectWiki' as const,
      repositoryId: 'r1',
      gitUrl: 'https://dev.azure.com/x/_git/w',
      version: 'wikiMaster',
      mappedPath: '/',
      rootPath: '/',
    };
    const a = setup(brainView({ wiki }), {
      'brain:refresh': () => ({
        ok: true,
        added: 1,
        changed: 0,
        removed: 0,
        pages: 4,
        attachments: 0,
      }),
    });
    render(<BrainScreen brainId="b1" />);
    const run = await openAdd();
    await userEvent.click(run.getByRole('button', { name: 'Digest' }));
    await userEvent.click(run.getByRole('button', { name: 'Refresh wiki' }));
    expect(a.calls).toContainEqual({
      channel: 'brain:run',
      args: ['b1', 'digest'],
    });
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:refresh',
        args: ['b1'],
      }),
    );
  });

  it('Ask sends the question with the terminal open, not by writing to it', async () => {
    const a = setup();
    render(<BrainScreen brainId="b1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask' }));
    await userEvent.type(
      screen.getByLabelText('Question'),
      'who owns billing?',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByTestId('terminal')).toHaveTextContent(
      'brain:b1/bt1',
    );
    expect(a.calls).toContainEqual({
      channel: 'brain:terminal',
      args: ['b1', null, '/ask who owns billing?'],
    });
    expect(names(a)).not.toContain('terminals:write');
  });

  it('Open terminal shows the brain terminal; Close kills it', async () => {
    const a = setup(brainView(), { 'terminals:kill': () => undefined });
    render(<BrainScreen brainId="b1" />);
    await userEvent.click(
      (await openAdd()).getByRole('button', { name: 'Open terminal' }),
    );
    expect(await screen.findByTestId('terminal')).toHaveTextContent(
      'brain:b1/bt1',
    );
    expect(a.calls).toContainEqual({ channel: 'brain:terminal', args: ['b1'] });
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('terminal')).not.toBeInTheDocument();
    expect(a.calls).toContainEqual({
      channel: 'terminals:kill',
      args: ['bt1'],
    });
  });

  it('Capture on an uncaptured finding queues a capture job, no terminal', async () => {
    const view = brainView();
    view.health!.findings = [
      {
        kind: 'uncaptured',
        page: 'sources/2026-11-04-deck.md',
        detail: 'not captured yet',
        at: '2026-11-04T10:00:00.000Z',
      },
    ];
    const a = setup(view);
    render(<BrainScreen brainId="b1" />);
    await openAdd();
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Capture sources/2026-11-04-deck.md',
      }),
    );
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:run',
        args: ['b1', 'capture', 'sources/2026-11-04-deck.md'],
      }),
    );
    expect(names(a)).not.toContain('brain:terminal');
  });

  it('Resolve in terminal sends a resolve prompt', async () => {
    const a = setup();
    render(<BrainScreen brainId="b1" />);
    await openAdd();
    const [first] = await screen.findAllByRole('button', {
      name: /Resolve in terminal/,
    });
    await userEvent.click(first);
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:terminal',
        args: [
          'b1',
          null,
          'resolve: broken-link on wiki/a.md: ../sources/gone.md does not exist',
        ],
      }),
    );
    expect(await screen.findByTestId('terminal')).toBeInTheDocument();
    expect(names(a)).not.toContain('terminals:write');
  });

  it('shows the cap pause in What runs by itself and resumes the queue', async () => {
    const paused = brainView();
    paused.health!.queuePaused = 'cap';
    const a = setup(paused);
    render(<BrainScreen brainId="b1" />);
    await openAdd();
    const auto = await screen.findByRole('region', {
      name: 'What runs by itself',
    });
    expect(within(auto).getByText('paused')).toBeInTheDocument();
    await userEvent.click(within(auto).getByRole('button', { name: 'Resume' }));
    expect(a.calls).toContainEqual({
      channel: 'brain:resumeQueue',
      args: ['b1'],
    });
  });

  it('refetches when the brain changes', async () => {
    let name = 'Acme';
    const a = installFakeApi({ 'brain:get': () => brainView({ name }) });
    render(<BrainScreen brainId="b1" />);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    name = 'Acme 2';
    a.emit('brain:changed', { brainId: 'other' });
    a.emit('brain:changed', { brainId: 'b1' });
    expect(await screen.findByText('Acme 2')).toBeInTheDocument();
    expect(names(a).filter((c) => c === 'brain:get')).toHaveLength(2);
  });

  it('loads pages, sources and the log once for both views, and once more per change', async () => {
    const a = setup(brainView(), {
      'brain:pages': () => [page('wiki/a.md', 'Page A')],
      'brain:sources': () => [],
      'brain:read': () => ({ text: '# Log\n' }),
    });
    render(<BrainScreen brainId="b1" />);
    await screen.findByRole('button', { name: /Page A/ });
    const count = (channel: string) =>
      names(a).filter((c) => c === channel).length;
    await waitFor(() => expect(count('brain:read')).toBe(1));
    expect(count('brain:pages')).toBe(1);
    expect(count('brain:sources')).toBe(1);
    a.emit('brain:changed', { brainId: 'b1' });
    await waitFor(() => expect(count('brain:pages')).toBe(2));
    expect(count('brain:sources')).toBe(2);
    expect(count('brain:read')).toBe(2);
  });

  it('Cmd+K or Ctrl+K anywhere focuses the Read search, but not while Add is shown', async () => {
    setup(brainView(), { 'brain:pages': () => [page('wiki/a.md', 'Page A')] });
    render(<BrainScreen brainId="b1" />);
    await screen.findByRole('button', { name: /Page A/ });
    const search = screen.getByLabelText('Search the brain');
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(search).toHaveFocus();
    search.blur();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(search).toHaveFocus();
    await openAdd();
    (document.activeElement as HTMLElement | null)?.blur();
    // fireEvent answers false when a handler took the key (preventDefault).
    expect(fireEvent.keyDown(document.body, { key: 'k', metaKey: true })).toBe(
      true,
    );
    expect(search).not.toHaveFocus();
  });

  it('Cmd+K typed in another field stays there', async () => {
    setup(brainView(), { 'brain:pages': () => [page('wiki/a.md', 'Page A')] });
    render(<BrainScreen brainId="b1" focus="ask" />);
    await screen.findByRole('button', { name: /Page A/ });
    const question = screen.getByLabelText('Question');
    question.focus();
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(question).toHaveFocus();
  });

  it('opens on Read, opens a page from the tree, and renders the log', async () => {
    const a = setup(brainView(), {
      'brain:pages': () => [page('wiki/a.md', 'Page A')],
      'brain:read': (_id, rel) => ({
        text:
          rel === 'log.md'
            ? '# Log\n\n- did a thing'
            : '---\ntitle: Page A\n---\n\n# Page A\n\nBody of A.',
      }),
    });
    render(<BrainScreen brainId="b1" />);
    expect(await screen.findByRole('tab', { name: 'Read' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Page A/ }),
    );
    expect(await screen.findByText('Body of A.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Log' }));
    expect(await screen.findByText('did a thing')).toBeInTheDocument();
    expect(a.calls).toContainEqual({
      channel: 'brain:read',
      args: ['b1', 'log.md'],
    });
  });

  it('focus drop opens on Add; the chosen view is remembered across remounts', async () => {
    setup();
    const first = render(<BrainScreen brainId="b1" focus="drop" />);
    expect(await screen.findByRole('tab', { name: /^Add/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    first.unmount();
    render(<BrainScreen brainId="b1" />);
    expect(await screen.findByRole('tab', { name: 'Read' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await openAdd();
    cleanup();
    render(<BrainScreen brainId="b1" />);
    expect(await screen.findByRole('tab', { name: /^Add/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('switching tracks the view', async () => {
    const a = setup();
    render(<BrainScreen brainId="b1" />);
    await openAdd();
    expect(a.tracked).toContainEqual(
      expect.objectContaining({
        name: 'brain.screen.action',
        props: { action: 'view-add' },
      }),
    );
  });

  it('the Add tab counts the sources waiting to capture, and shows nothing at zero', async () => {
    let sources = [source('sources/a.md'), source('sources/b.md')];
    const a = setup(brainView(), { 'brain:sources': () => sources });
    render(<BrainScreen brainId="b1" />);
    expect(
      await screen.findByRole('tab', { name: 'Add, 2 waiting' }),
    ).toBeInTheDocument();
    sources = [];
    a.emit('brain:changed', { brainId: 'b1' });
    expect(await screen.findByRole('tab', { name: 'Add' })).toBeInTheDocument();
  });

  it('keeps the open page when switching to Add and back', async () => {
    setup(brainView(), {
      'brain:pages': () => [page('wiki/a.md', 'Page A')],
      'brain:read': () => ({
        text: '---\ntitle: Page A\n---\n\n# Page A\n\nBody of A.',
      }),
    });
    render(<BrainScreen brainId="b1" />);
    await userEvent.click(
      await screen.findByRole('button', { name: /Page A/ }),
    );
    expect(await screen.findByText('Body of A.')).toBeVisible();
    await openAdd();
    expect(screen.getByText('Body of A.')).not.toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Read' }));
    expect(screen.getByText('Body of A.')).toBeVisible();
  });

  it("a done capture's pages-changed link switches to Read with the page open", async () => {
    setup(
      brainView({
        jobs: [
          brainJob({
            status: 'done',
            error: null,
            source: 'sources/2026-11-02-sow.md',
          }),
        ],
      }),
      {
        'brain:pages': () => [page('wiki/a.md', 'A')],
        'brain:read': (_id, rel) => ({
          text:
            rel === 'log.md'
              ? '- 2026-11-02T10:00:30.000Z /capture sources/2026-11-02-sow.md → pages: a; takeaway: x\n'
              : '---\ntitle: A\n---\n\n# A\n\nBody of A.',
        }),
      },
    );
    render(<BrainScreen brainId="b1" focus="drop" />);
    await userEvent.click(
      await screen.findByRole('button', { name: '1 page changed' }),
    );
    expect(screen.getByRole('tab', { name: 'Read' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText('Body of A.')).toBeVisible();
  });

  it('More holds Open folder and Brain settings', async () => {
    const a = setup();
    render(<BrainScreen brainId="b1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'More' }));
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Open folder' }),
    );
    expect(a.calls).toContainEqual({
      channel: 'brain:openFolder',
      args: ['b1'],
    });
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Brain settings' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      scope: 'project',
      connectionId: 'c1',
      section: 'project-brains',
    });
  });

  it('the header has no maintenance buttons', async () => {
    setup();
    render(<BrainScreen brainId="b1" />);
    const head = within(await screen.findByRole('banner'));
    for (const name of ['Lint', 'Digest', 'Refresh wiki', 'Open terminal'])
      expect(head.queryByRole('button', { name })).not.toBeInTheDocument();
  });
});

describe('BrainScreen scrub', () => {
  it('sends the value to main and reports the count, never writing it anywhere else', async () => {
    const a = setup(brainView(), {
      'brain:scrub': () => ({ files: 3, skipped: 0 }),
    });
    render(<BrainScreen brainId="b1" />);
    await openAdd();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Scrub a value…' }),
    );
    await userEvent.type(screen.getByLabelText('Value to redact'), 'hunter2x!');
    await userEvent.click(
      screen.getByRole('button', { name: 'Redact everywhere' }),
    );
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:scrub',
        args: ['b1', 'hunter2x!'],
      }),
    );
    expect(useStore.getState().notices.map((n) => n.message)).toContainEqual(
      expect.stringContaining('Redacted in 3 files'),
    );
  });
});
