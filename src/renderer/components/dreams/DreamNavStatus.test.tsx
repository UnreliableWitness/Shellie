import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultDreaming, type DreamView } from '../../../shared/dreams';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { DreamNavStatus } from './DreamNavStatus';
import { settings, viewOf } from '../../test-helpers/dreamFixtures';
import { activateProject } from '../../test-helpers/project';

beforeEach(() => {
  useStore.setState({ screen: { kind: 'home' }, previous: null, notices: [] });
});

const running = (): DreamView =>
  viewOf({
    waiting: null,
    running: {
      repoId: 'r2',
      startedAt: Date.now() - 4 * 60_000,
      step: 'reading',
    },
  });

describe('DreamNavStatus', () => {
  it('shows nothing in the nav unless a dream runs, when asked for only that', async () => {
    const { calls } = installFakeApi({ 'dream:get': () => viewOf() });
    activateProject();
    const { unmount } = render(<DreamNavStatus rail={false} onlyRunning />);
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'dream:get')).toBe(true),
    );
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
  });

  it.each([
    [viewOf({ settings: defaultDreaming() }), 'Dreams off'],
    [viewOf(), 'Dreams on · zai/glm-5.3'],
    [
      viewOf({ settings: settings({ limit: { kind: 'none' } }) }),
      'Dreams on · no limit · zai/glm-5.3',
    ],
  ])('shows the line %#', async (view, text) => {
    installFakeApi({ 'dream:get': () => view });
    render(<DreamNavStatus rail={false} />);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('opens Dreams on click', async () => {
    installFakeApi({ 'dream:get': () => viewOf() });
    render(<DreamNavStatus rail={false} />);
    await userEvent.click(await screen.findByRole('button'));
    expect(useStore.getState().screen).toEqual({ kind: 'dreams' });
  });

  it('is an icon button named by the full line in the rail', async () => {
    installFakeApi({ 'dream:get': () => viewOf() });
    render(<DreamNavStatus rail />);
    expect(
      await screen.findByRole('button', { name: 'Dreams on · zai/glm-5.3' }),
    ).toBeInTheDocument();
  });

  it('while running opens the panel with the step, and Stop this dream calls dream:stop', async () => {
    const { calls } = installFakeApi({ 'dream:get': () => running() });
    render(<DreamNavStatus rail={false} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /Dreaming about billing/ }),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'home' });
    expect(screen.getByText('Reading sessions')).toBeInTheDocument();
    expect(screen.getByText('1.2 of 5 million tokens')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Stop this dream' }),
    );
    // Stop names the project whose dream it is.
    expect(
      calls.filter((c) => c.channel === 'dream:stop').map((c) => c.args),
    ).toEqual([['p1']]);
    expect(screen.queryByText('Reading sessions')).toBeNull();
  });

  it('says what a running dream checks, and links to Dreams', async () => {
    const v = running();
    v.running!.step = 'checking';
    installFakeApi({ 'dream:get': () => v });
    render(<DreamNavStatus rail={false} />);
    await userEvent.click(
      await screen.findByRole('button', { name: /Dreaming about/ }),
    );
    expect(screen.getByText('Checking its own proposals')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Dreams' }));
    expect(useStore.getState().screen).toEqual({ kind: 'dreams' });
  });

  it('closes on Escape and on an outside click, returning focus to the line', async () => {
    installFakeApi({ 'dream:get': () => running() });
    render(
      <>
        <DreamNavStatus rail={false} />
        <button type="button">elsewhere</button>
      </>,
    );
    const line = await screen.findByRole('button', { name: /Dreaming about/ });
    await userEvent.click(line);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('Reading sessions')).toBeNull();
    expect(line).toHaveFocus();
    await userEvent.click(line);
    expect(screen.getByText('Reading sessions')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByText('Reading sessions')).toBeNull();
  });
});

describe('dreams of another project', () => {
  it('shows nothing of a dream that runs for another project: the plain line, no panel, no Stop', async () => {
    installFakeApi({
      'dream:get': () =>
        viewOf({
          settings: settings({ enabled: true }),
          waiting: 'running-elsewhere',
          running: null,
        }),
    });
    render(<DreamNavStatus rail={false} />);
    const line = await screen.findByRole('button', { name: /Dreams on/ });
    expect(line).not.toHaveAttribute('aria-haspopup');
    await userEvent.click(line);
    expect(
      screen.queryByRole('button', { name: 'Stop this dream' }),
    ).toBeNull();
    expect(useStore.getState().screen).toEqual({ kind: 'dreams' });
  });

  it('without a project there is no status line', async () => {
    const { calls } = installFakeApi();
    useStore.setState({ connections: [], connectionId: null });
    const { container } = render(<DreamNavStatus rail={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    expect(calls.filter((c) => c.channel === 'dream:get')).toHaveLength(0);
  });
});

// Dreams belong to a project: every test here has one active.
beforeEach(() => {
  activateProject();
});
