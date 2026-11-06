import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
/** The page header's commands; the Add view's Run now has buttons of the same names. */
const header = async () => {
  await screen.findByText('Acme');
  return within(screen.getByRole('banner'));
};

beforeEach(() =>
  useStore.setState({ notices: [], screen: { kind: 'brain', brainId: 'b1' } }),
);

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
      (await header()).getByRole('button', { name: 'Lint' }),
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
    const a = setup(brainView(), {
      'brain:refresh': () => ({
        ok: true,
        added: 1,
        changed: 0,
        removed: 0,
        pages: 4,
      }),
    });
    render(<BrainScreen brainId="b1" />);
    const head = await header();
    await userEvent.click(head.getByRole('button', { name: 'Digest' }));
    await userEvent.click(head.getByRole('button', { name: 'Refresh wiki' }));
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
      (await header()).getByRole('button', { name: 'Open terminal' }),
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

  it('shows the wiki in the Read view, opens a page, and renders the log', async () => {
    const a = setup(brainView(), {
      'brain:pages': () => [
        {
          path: 'wiki/a.md',
          title: 'Page A',
          summary: 'About A.',
          type: 'other',
          lastUpdated: '2026-11-03',
          confidence: 'high',
          verified: null,
          changedSinceVerified: false,
          sources: [],
          linkedFrom: [],
        },
      ],
      'brain:read': (_id, rel) => ({
        text:
          rel === 'log.md'
            ? '# Log\n\n- did a thing'
            : '---\ntitle: Page A\n---\n\n# Page A\n\nBody of A.',
      }),
    });
    render(<BrainScreen brainId="b1" />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Wiki' }));
    await userEvent.click(
      await screen.findByRole('button', { name: /Page A/ }),
    );
    expect(await screen.findByText('Body of A.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    await userEvent.click(screen.getByRole('tab', { name: 'Log' }));
    expect(await screen.findByText('did a thing')).toBeInTheDocument();
    expect(a.calls).toContainEqual({
      channel: 'brain:read',
      args: ['b1', 'log.md'],
    });
  });
});

describe('BrainScreen scrub', () => {
  it('sends the value to main and reports the count, never writing it anywhere else', async () => {
    const a = setup(brainView(), {
      'brain:scrub': () => ({ files: 3, skipped: 0 }),
    });
    render(<BrainScreen brainId="b1" />);
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
