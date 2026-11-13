import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JoinPreview } from '../../shared/brainShare';
import { useStore } from '../store';
import { brainView } from '../test-helpers/brainFixture';
import { installFakeApi, type FakeHandlers } from '../test-helpers/fakeApi';
import { BrainJoinScreen } from './BrainJoinScreen';

const preview = (over: Partial<JoinPreview> = {}): JoinPreview => ({
  name: 'Acme',
  organizationUrl: 'https://dev.azure.com/acme',
  project: 'Shellie',
  connectionId: 'c1',
  needsToken: false,
  alreadyHave: false,
  ...over,
});
const setup = (p: JoinPreview, over: FakeHandlers = {}) =>
  installFakeApi({
    'brain:previewJoin': () => p,
    'brain:join': () => brainView({ id: 'joined' }),
    ...over,
  });
beforeEach(() => useStore.setState({ screen: { kind: 'home' } }));

describe('BrainJoinScreen', () => {
  it('joins and opens the brain', async () => {
    const a = setup(preview());
    render(<BrainJoinScreen link="shellie://join?x" />);
    expect(
      await screen.findByText('Acme, the brain for Shellie'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'brain',
        brainId: 'joined',
      }),
    );
    expect(a.calls).toContainEqual({
      channel: 'brain:join',
      args: ['shellie://join?x', undefined, 'link'],
    });
  });
  it('asks to add the project first when there is no connection', async () => {
    setup(preview({ connectionId: null }));
    render(<BrainJoinScreen link="l" />);
    expect(
      await screen.findByText('Add the Shellie project in Shellie first.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Join' }),
    ).not.toBeInTheDocument();
  });
  it('asks for a token when the link needs one and joins with it, saying the card opened it', async () => {
    const a = setup(preview({ needsToken: true }));
    render(<BrainJoinScreen link="l" via="card" />);
    await userEvent.type(await screen.findByLabelText('Token'), 'secret-pat');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:join',
        args: ['l', 'secret-pat', 'card'],
      }),
    );
  });
  it('says when the person already has the brain', async () => {
    setup(preview({ alreadyHave: true }));
    render(<BrainJoinScreen link="l" />);
    expect(
      await screen.findByText('You already have a brain for this project.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Join' }),
    ).not.toBeInTheDocument();
  });
  it('shows an access error from the join', async () => {
    setup(preview(), {
      'brain:join': () => {
        throw new Error('Access denied: you are not a member of acme');
      },
    });
    render(<BrainJoinScreen link="l" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Join' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Access denied: you are not a member of acme',
    );
    expect(useStore.getState().screen).toEqual({ kind: 'home' });
  });
});
