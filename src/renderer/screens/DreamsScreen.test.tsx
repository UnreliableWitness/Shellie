import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDreaming, type DreamView } from '../../shared/dreams';
import {
  emptyState,
  journalEntry,
  OPENED,
  settings,
  viewOf,
  withResults,
} from '../test-helpers/dreamFixtures';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { AwayBand } from '../components/dreams/AwayBand';
import { DreamsScreen } from './DreamsScreen';
import { activateProject, PROJECT_ID } from '../test-helpers/project';

beforeEach(() => {
  useStore.setState({
    screen: { kind: 'dreams' },
    previous: null,
    notices: [],
  });
});

const open = (
  view: DreamView,
  extra: Parameters<typeof installFakeApi>[0] = {},
) => installFakeApi({ 'dream:get': () => view, ...extra });

/** The calls of a channel. A call about a project's setup must name the active project; what follows it is returned. */
const OF_PROJECT = [
  'dream:save',
  'dream:test',
  'dream:switchOn',
  'dream:switchOff',
];
const callsOf = (
  calls: { channel: string; args: unknown[] }[],
  channel: string,
) =>
  calls
    .filter((c) => c.channel === channel)
    .map((c) => {
      if (!OF_PROJECT.includes(channel)) return c.args;
      expect(c.args[0]).toBe(PROJECT_ID);
      return c.args.slice(1);
    });

describe('DreamsScreen: off', () => {
  const off = () =>
    viewOf({
      settings: defaultDreaming(),
      journal: [journalEntry({ at: '2020-01-01T10:00:00' })],
    });

  it('shows the invitation, no status strip and only the journal below', async () => {
    open(off());
    render(<DreamsScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Set up dreaming' }),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'dream-setup' });
    expect(screen.queryByRole('region', { name: 'Status' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Repos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Switch off' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Journal' })).toHaveTextContent(
      '2 proposals, waiting for you',
    );
  });

  it('names both models when dreaming switched itself off, and goes to setup', async () => {
    open(
      viewOf({
        settings: defaultDreaming(),
        switchedOff: {
          answered: 'github-copilot/gpt-5',
          chosen: 'zai/glm-5.3',
          repoId: 'r1',
        },
      }),
    );
    render(<DreamsScreen />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('github-copilot/gpt-5');
    expect(alert).toHaveTextContent('zai/glm-5.3');
    await userEvent.click(
      within(alert).getByRole('button', { name: 'Test the model again' }),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'dream-setup' });
  });
});

describe('DreamsScreen: a re-test that another model answered', () => {
  it('says the test call was answered by the other model, naming no repo or dream', async () => {
    open(
      viewOf({
        settings: defaultDreaming(),
        switchedOff: { answered: 'a/b', chosen: 'zai/glm-5.3', repoId: '' },
      }),
    );
    render(<DreamsScreen />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'The test call was answered by a/b instead of zai/glm-5.3. Nothing was changed.',
    );
  });
});

describe('DreamsScreen: on', () => {
  it('shows four status cells with the usage as a progress bar', async () => {
    open(viewOf());
    render(<DreamsScreen />);
    const strip = await screen.findByRole('region', { name: 'Status' });
    expect(within(strip).getByText('zai/glm-5.3')).toBeInTheDocument();
    expect(
      within(strip).getByText('1.2 of 5 million tokens'),
    ).toBeInTheDocument();
    expect(within(strip).getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '24',
    );
    expect(
      within(strip).getByText('After 10 minutes idle'),
    ).toBeInTheDocument();
    expect(
      within(strip).getByText('Waiting until you are away'),
    ).toBeInTheDocument();
  });

  it('has no bar without a limit', async () => {
    open(viewOf({ settings: settings({ limit: { kind: 'none' } }) }));
    render(<DreamsScreen />);
    await screen.findByText('1.2 million tokens · no limit');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('lists a Review row per open result and opens it', async () => {
    open(withResults());
    render(<DreamsScreen />);
    const waiting = await screen.findByRole('region', {
      name: 'Waiting for you',
    });
    expect(
      within(waiting).getAllByRole('button', { name: 'Review' }),
    ).toHaveLength(2);
    expect(waiting).toHaveTextContent(
      'New rule: write migrations by hand, and 1 more',
    );
    await userEvent.click(
      within(waiting).getAllByRole('button', { name: 'Review' })[1],
    );
    expect(useStore.getState().screen).toEqual({ kind: 'dream', repoId: 'r2' });
  });

  it('offers to make the task of a result opened as a task whose task was never made', async () => {
    const v = viewOf();
    v.repos[0].state = emptyState({ opened: OPENED });
    open(v);
    render(<DreamsScreen />);
    const waiting = await screen.findByRole('region', {
      name: 'Waiting for you',
    });
    expect(waiting).toHaveTextContent(
      'portal · 2 kept proposals on dream/2026-11-20-1, no task yet',
    );
    await userEvent.click(
      within(waiting).getByRole('button', { name: 'Make the task' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'new-task',
      repoId: 'r1',
      dream: {
        id: '2026-11-20-1',
        branch: 'dream/2026-11-20-1',
        name: 'Dream 20 Nov',
      },
    });
  });

  it('Leave the branch asks first, then forgets the record (the branch stays)', async () => {
    const v = viewOf();
    v.repos[0].state = emptyState({ opened: OPENED });
    const { calls } = open(v);
    render(<DreamsScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Leave the branch' }),
    );
    expect(callsOf(calls, 'dream:leaveBranch')).toEqual([]);
    expect(
      screen.getByText(
        'Forget this? The branch dream/2026-11-20-1 stays in the repo, but Shellie no longer offers to make a task from it.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Forget it' }));
    await waitFor(() =>
      expect(callsOf(calls, 'dream:leaveBranch')).toEqual([['r1']]),
    );
  });

  it('shows what waits also while dreaming is off', async () => {
    const v = viewOf({ settings: defaultDreaming() });
    v.repos[0].state = emptyState({ opened: OPENED });
    open(v);
    render(<DreamsScreen />);
    await screen.findByRole('button', { name: 'Make the task' });
    expect(screen.queryByRole('region', { name: 'Status' })).toBeNull();
  });

  it('names a removed repo’s journal line by the name stored with it', async () => {
    open(
      viewOf({
        journal: [
          journalEntry({ dreamId: 'a', repoId: 'gone', repoName: 'shop' }),
          journalEntry({ dreamId: 'b', repoId: 'gone2' }),
        ],
      }),
    );
    render(<DreamsScreen />);
    const journal = await screen.findByRole('region', { name: 'Journal' });
    expect(journal).toHaveTextContent('shop');
    expect(journal).toHaveTextContent('a removed repo');
    expect(journal).not.toHaveTextContent('gone2');
  });

  it('Dream now calls dream:now and is disabled for a repo with an open result', async () => {
    const v = withResults();
    v.repos[2].state = { ...v.repos[2].state };
    const { calls } = open({
      ...v,
      settings: settings({
        repos: { ...v.settings.repos, r3: { on: true, folders: ['x'] } },
      }),
    });
    render(<DreamsScreen />);
    const repos = await screen.findByRole('region', { name: 'Repos' });
    const buttons = within(repos).getAllByRole('button', { name: 'Dream now' });
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();
    await userEvent.click(buttons[2]);
    expect(callsOf(calls, 'dream:now')).toEqual([['r3']]);
  });

  it('says in words why a dream did not start', async () => {
    open(viewOf(), { 'dream:now': () => ({ wait: 'battery' }) });
    render(<DreamsScreen />);
    const repos = await screen.findByRole('region', { name: 'Repos' });
    await userEvent.click(
      within(repos).getAllByRole('button', { name: 'Dream now' })[0],
    );
    expect(await within(repos).findByRole('status')).toHaveTextContent(
      'Waiting for mains power',
    );
  });

  it('offers Add for a repo that is off, which opens setup', async () => {
    open(viewOf());
    render(<DreamsScreen />);
    const repos = await screen.findByRole('region', { name: 'Repos' });
    expect(
      within(repos).getByText('Its sessions are never read'),
    ).toBeInTheDocument();
    await userEvent.click(within(repos).getByRole('button', { name: 'Add' }));
    expect(useStore.getState().screen).toEqual({ kind: 'dream-setup' });
  });

  it('Change setup goes to setup', async () => {
    open(viewOf());
    render(<DreamsScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Change setup' }),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'dream-setup' });
  });

  it('Switch off asks first, then calls dream:switchOff', async () => {
    const { calls } = open(viewOf());
    render(<DreamsScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Switch off' }),
    );
    expect(
      screen.getByText(
        'Switch off dreaming? A dream that is running is stopped.',
      ),
    ).toBeInTheDocument();
    expect(callsOf(calls, 'dream:switchOff')).toEqual([]);
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Switch off',
      }),
    );
    await waitFor(() =>
      expect(callsOf(calls, 'dream:switchOff')).toEqual([[]]),
    );
  });

  it('shows dream text as plain text, never as HTML', async () => {
    const v = withResults();
    v.repos[0].state.result!.proposals[0].title =
      '<img src=x onerror=alert(1)>';
    open(v);
    render(<DreamsScreen />);
    const waiting = await screen.findByRole('region', {
      name: 'Waiting for you',
    });
    expect(waiting).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(waiting.querySelector('img')).toBeNull();
  });

  it('lists the journal newest first with tokens', async () => {
    open(
      viewOf({
        journal: [
          journalEntry({
            dreamId: 'a',
            outcome: 'nothing',
            proposals: 0,
            tokens: 220_000,
            at: '2020-01-02T10:00:00',
          }),
          journalEntry({
            dreamId: 'b',
            outcome: 'failed',
            reason: 'OpenCode stopped',
            tokens: 2_140_000,
            at: '2020-01-01T10:00:00',
          }),
        ],
      }),
    );
    render(<DreamsScreen />);
    const journal = await screen.findByRole('region', { name: 'Journal' });
    expect(journal).toHaveTextContent('Nothing to propose');
    expect(journal).toHaveTextContent('220 000');
    expect(journal).toHaveTextContent('Failed: OpenCode stopped');
    expect(journal).toHaveTextContent('2 Jan');
  });

  it('keeps the rows of two repos that dreamt the same day apart (dream ids are per repo)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const v = withResults({
      journal: [
        journalEntry({ dreamId: '2020-01-02-1', repoId: 'r1' }),
        journalEntry({ dreamId: '2020-01-02-1', repoId: 'r2' }),
      ],
    });
    v.repos[1].state.result!.id = v.repos[0].state.result!.id;
    open(v);
    render(
      <>
        <AwayBand />
        <DreamsScreen />
      </>,
    );
    await screen.findByRole('region', { name: 'Journal' });
    await screen.findByRole('region', { name: 'While you were away' });
    expect(
      error.mock.calls.some((c) => String(c[0]).includes('same key')),
    ).toBe(false);
    error.mockRestore();
  });

  it('offers Try again when the first load fails', async () => {
    let n = 0;
    installFakeApi({
      'dream:get': () => {
        if (n++ === 0) throw new Error('boom');
        return viewOf();
      },
    });
    render(<DreamsScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Try again' }),
    );
    expect(
      await screen.findByRole('region', { name: 'Status' }),
    ).toBeInTheDocument();
  });
});

describe('DreamsScreen: a repo without a project', () => {
  it('shows what it left to review, but not among the repos that can dream', async () => {
    const v = withResults();
    v.repos[0] = { ...v.repos[0], orphan: true };
    installFakeApi({ 'dream:get': () => v });
    render(<DreamsScreen />);
    const repos = await screen.findByRole('region', { name: 'Repos' });
    expect(within(repos).queryByText(v.repos[0].name)).toBeNull();
    expect(within(repos).getByText(v.repos[1].name)).toBeInTheDocument();
    expect(screen.getAllByText(v.repos[0].name).length).toBeGreaterThan(0);
  });
});

// Dreams belong to a project: every test here has one active.
beforeEach(() => {
  activateProject();
});
