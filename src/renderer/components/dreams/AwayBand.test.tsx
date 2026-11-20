import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultDreaming } from '../../../shared/dreams';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { AwayBand } from './AwayBand';
import {
  emptyState,
  journalEntry,
  result,
  settings,
  viewOf,
  withResults,
} from './dreamFixtures';

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ screen: { kind: 'home' }, previous: null, notices: [] });
});

describe('AwayBand', () => {
  it('is absent without an open result', async () => {
    const { calls } = installFakeApi({ 'dream:get': () => viewOf() });
    const { container } = render(<AwayBand />);
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'dream:get')).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('lists every proposal title of each result and reviews one', async () => {
    installFakeApi({ 'dream:get': () => withResults() });
    render(<AwayBand />);
    const band = await screen.findByRole('region', {
      name: 'While you were away',
    });
    for (const t of [
      'New rule: write migrations by hand',
      'Skill: release notes',
      'New skill: run the VAT test set',
    ])
      expect(within(band).getByText(t)).toBeInTheDocument();
    expect(band).toHaveTextContent('zai/glm-5.3');
    await userEvent.click(
      within(band).getAllByRole('button', { name: 'Review' })[0],
    );
    expect(useStore.getState().screen).toEqual({ kind: 'dream', repoId: 'r1' });
  });

  it('hides a card after Not now, keeps it hidden after a remount, shows a new dream id', async () => {
    let view = withResults();
    installFakeApi({ 'dream:get': () => view });
    const first = render(<AwayBand />);
    await screen.findByRole('region', { name: 'While you were away' });
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Not now' })[0],
    );
    expect(screen.queryByText('Skill: release notes')).toBeNull();
    expect(
      screen.getByText('New skill: run the VAT test set'),
    ).toBeInTheDocument();
    first.unmount();

    render(<AwayBand />);
    await screen.findByText('New skill: run the VAT test set');
    expect(screen.queryByText('Skill: release notes')).toBeNull();

    // A new dream for the same repo is a new id: the card is back.
    view = withResults();
    view.repos[0].state = emptyState({
      result: result('c', 'r1', ['Fresh idea']),
    });
    first.unmount();
    render(<AwayBand />);
    expect(await screen.findByText('Fresh idea')).toBeInTheDocument();
  });

  it('prunes stored ids that no longer have an open result', async () => {
    localStorage.setItem(
      'shellie.dreams.hiddenOnHome',
      JSON.stringify({ r1: ['gone'], r9: ['x'] }),
    );
    installFakeApi({ 'dream:get': () => withResults() });
    render(<AwayBand />);
    await screen.findByRole('region', { name: 'While you were away' });
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Not now' })[1],
    );
    expect(
      JSON.parse(localStorage.getItem('shellie.dreams.hiddenOnHome')!),
    ).toEqual({
      r2: ['b'],
    });
  });

  it('survives a broken storage value', async () => {
    localStorage.setItem('shellie.dreams.hiddenOnHome', '{nope');
    installFakeApi({ 'dream:get': () => withResults() });
    render(<AwayBand />);
    expect(
      await screen.findByRole('region', { name: 'While you were away' }),
    ).toBeInTheDocument();
  });

  it('adds one quiet line for a dream that found nothing', async () => {
    const v = withResults();
    v.journal = [
      journalEntry({
        outcome: 'nothing',
        repoId: 'r2',
        proposals: 0,
        at: new Date().toISOString(),
      }),
    ];
    installFakeApi({ 'dream:get': () => v });
    render(<AwayBand />);
    expect(
      await screen.findByText(/found nothing to propose/),
    ).toHaveTextContent('A dream for billing found nothing to propose');
    await userEvent.click(screen.getByRole('button', { name: 'All dreams' }));
    expect(useStore.getState().screen).toEqual({ kind: 'dreams' });
  });

  it('shows the switched-off notice alone, naming both models, and goes to setup', async () => {
    installFakeApi({
      'dream:get': () =>
        viewOf({
          settings: settings({ ...defaultDreaming() }),
          switchedOff: { answered: 'a/b', chosen: 'c/d', repoId: 'r1' },
        }),
    });
    render(<AwayBand />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('a/b');
    expect(alert).toHaveTextContent('c/d');
    expect(screen.queryByRole('region')).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'Test the model again' }),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'dream-setup' });
  });

  it('drops the notice once dreaming is on again', async () => {
    installFakeApi({
      'dream:get': () =>
        viewOf({
          switchedOff: { answered: 'a/b', chosen: 'c/d', repoId: 'r1' },
        }),
    });
    const { container } = render(<AwayBand />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });
});
