import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { listedBrain } from '../../test-helpers/brainFixture';
import { installFakeApi, type FakeHandlers } from '../../test-helpers/fakeApi';
import { JoinCard } from './JoinCard';

const found = [
  { repositoryId: 'r1', name: 'Acme', joinLink: 'shellie://join?a' },
];
const setup = (over: FakeHandlers = {}) =>
  installFakeApi({ 'brain:discover': () => found, ...over });

beforeEach(() => useStore.setState({ screen: { kind: 'home' } }));

describe('JoinCard', () => {
  it('offers the join when the project has a shared brain and there is no local one', async () => {
    setup();
    render(<JoinCard connectionId="c1" project="Shellie" />);
    expect(
      await screen.findByText('Your team has a brain for Shellie. Join?'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'brain-join',
      link: 'shellie://join?a',
      via: 'card',
    });
  });
  it('shows nothing when no shared brain is found', async () => {
    const a = setup({ 'brain:discover': () => [] });
    const { container } = render(
      <JoinCard connectionId="c1" project="Shellie" />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(a.calls.some((c) => c.channel === 'brain:discover')).toBe(true);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows nothing when the person already has a brain for the project', async () => {
    setup({ 'brain:list': () => [listedBrain()] });
    const { container } = render(
      <JoinCard connectionId="c1" project="Shellie" />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
