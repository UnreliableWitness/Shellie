import { render, screen, waitFor } from '@testing-library/react';
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
    await userEvent.click(await screen.findByRole('button', { name: 'Lint' }));
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
    await userEvent.click(
      await screen.findByRole('button', { name: 'Digest' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Refresh wiki' }));
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
      await screen.findByRole('button', { name: 'Open terminal' }),
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

  it('shows the cap pause and resumes the queue', async () => {
    const paused = brainView();
    paused.health!.queuePaused = 'cap';
    const a = setup(paused);
    render(<BrainScreen brainId="b1" />);
    expect(await screen.findByText(/paused/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
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

  it('lists the files of a tab and renders the log', async () => {
    const a = setup(brainView(), {
      'brain:files': (_id, dir) =>
        dir === 'wiki' ? [{ path: 'wiki/a.md', changed: null }] : [],
      'brain:read': (_id, rel) => ({
        text: rel === 'log.md' ? '# Log\n\n- did a thing' : '# Page A',
      }),
    });
    render(<BrainScreen brainId="b1" />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Wiki' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'wiki/a.md' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Page A' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Log' }));
    expect(await screen.findByText('did a thing')).toBeInTheDocument();
    expect(a.calls).toContainEqual({
      channel: 'brain:read',
      args: ['b1', 'log.md'],
    });
  });
});
