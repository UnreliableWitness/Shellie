import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Connection, Repo } from '../../shared/types';
import { type AppSettings, defaultSettings } from '../../shared/usage';
import { useStore } from '../store';
import { brainView, listedBrain } from '../test-helpers/brainFixture';
import { installFakeApi } from '../test-helpers/fakeApi';
import { BrainNewScreen } from './BrainNewScreen';

const conn = (id: string, project: string): Connection => ({
  id,
  name: 'unreliablewitness',
  organizationUrl: 'https://dev.azure.com/unreliablewitness',
  project,
  user: 'Dries Hoebeke',
  status: 'ok',
  checkedAt: null,
  userUniqueName: null,
  provider: 'azure-devops',
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
});

const settings = (): AppSettings => {
  const s = defaultSettings();
  return {
    ...s,
    onboarding: { ...s.onboarding, agentsCheckedAt: '2026-10-22T09:00:00Z' },
  };
};

const repo = { id: 'r1', name: 'webshop' } as Repo;

function open(
  connections: Connection[] = [conn('c1', 'Shellie')],
  repos: Repo[] = [repo],
) {
  useStore.setState({
    screen: { kind: 'brain-new', from: 'get-started' },
    previous: { kind: 'get-started' },
    notices: [],
    connections,
    repos,
    settings: settings(),
  });
}

beforeEach(() => open());

describe('BrainNewScreen', () => {
  it('has the step strip, the header, the intro and the form for the one project', async () => {
    installFakeApi();
    render(<BrainNewScreen />);
    expect(screen.getByRole('list', { name: 'Setup steps' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'A brain for your project' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Drop documents or point it at the project's wiki; your agent writes them up as pages, and every task of the project can read them.",
      ),
    ).toBeTruthy();
    expect(await screen.findByLabelText('Name')).toHaveValue('Shellie brain');
    expect(
      screen.queryByRole('combobox', { name: 'Create it for' }),
    ).toBeNull();
  });

  it('with several projects a select picks the one the form is for', async () => {
    open([conn('c1', 'Shellie'), conn('c2', 'Webshop')]);
    installFakeApi();
    render(<BrainNewScreen />);
    expect(await screen.findByLabelText('Name')).toHaveValue('Shellie brain');
    const pick = screen.getByRole('combobox', { name: 'Create it for' });
    expect(
      Array.from(pick.querySelectorAll('option')).map((o) => o.textContent),
    ).toEqual(['unreliablewitness / Shellie', 'unreliablewitness / Webshop']);
    await userEvent.selectOptions(pick, 'unreliablewitness / Webshop');
    expect(screen.getByLabelText('Name')).toHaveValue('Webshop brain');
  });

  it('Skip for now saves brain none and goes Home when everything else is done', async () => {
    const saved: AppSettings[] = [];
    const { tracked } = installFakeApi({
      'settings:get': () => settings(),
      'settings:save': (s) => {
        saved.push(s);
        return s;
      },
    });
    render(<BrainNewScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'home' }),
    );
    expect(saved[0].onboarding.brain).toBe('none');
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'onboarding.step',
      props: { step: 'brain', outcome: 'skipped' },
    });
  });

  it('creating a brain goes on to the next unfinished step', async () => {
    open([conn('c1', 'Shellie')], []);
    const { tracked } = installFakeApi({ 'brain:create': () => brainView() });
    render(<BrainNewScreen />);
    await screen.findByLabelText('Name');
    await userEvent.click(screen.getByRole('button', { name: 'Create brain' }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'add-repo',
        from: 'get-started',
      }),
    );
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'onboarding.step',
      props: { step: 'brain', outcome: 'continued' },
    });
  });

  it('Back returns to Get started', async () => {
    const { tracked } = installFakeApi();
    render(<BrainNewScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(useStore.getState().screen).toEqual({ kind: 'get-started' });
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'onboarding.step',
      props: { step: 'brain', outcome: 'back' },
    });
  });

  it('goes straight on when the project already has a brain', async () => {
    installFakeApi({ 'brain:list': () => [listedBrain()] });
    render(<BrainNewScreen />);
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'home' }),
    );
  });

  it('an archived brain does not count', async () => {
    const { calls } = installFakeApi({
      'brain:list': () => [listedBrain({ archived: true })],
    });
    render(<BrainNewScreen />);
    await waitFor(() =>
      expect(calls.map((c) => c.channel)).toContain('brain:list'),
    );
    expect(await screen.findByLabelText('Name')).toBeTruthy();
    expect(useStore.getState().screen.kind).toBe('brain-new');
  });

  it('without a connected project it offers Connect instead of the form', async () => {
    open([]);
    installFakeApi();
    render(<BrainNewScreen />);
    expect(await screen.findByText('Connect a project first.')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'connect',
      from: 'get-started',
    });
  });
});
