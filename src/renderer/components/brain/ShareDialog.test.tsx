import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import { brainJob, brainView } from '../../test-helpers/brainFixture';
import { installFakeApi, type FakeHandlers } from '../../test-helpers/fakeApi';
import { ShareDialog } from './ShareDialog';

const connection = {
  id: 'c1',
  name: 'uw',
  organizationUrl: 'https://dev.azure.com/customerorg',
  project: 'Shellie',
  user: 'D',
  status: 'ok' as const,
  checkedAt: null,
  userUniqueName: null,
  provider: 'azure-devops' as const,
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
};
const company = {
  organizationUrl: 'https://dev.azure.com/acme',
  project: 'Brains',
  user: 'D',
};

beforeEach(() => {
  useStore.setState({ connections: [connection] });
});

const setup = (over: FakeHandlers = {}) =>
  installFakeApi({ 'brainHome:get': () => null, ...over });

describe('ShareDialog', () => {
  it('defaults to the customer project when no company home is set', async () => {
    setup();
    render(
      <ShareDialog brain={brainView()} onClose={vi.fn()} onSources={vi.fn()} />,
    );
    expect(
      await screen.findByRole('radio', {
        name: 'This customer project (customerorg/Shellie)',
        checked: true,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Company brain home/)).not.toBeInTheDocument();
    expect(
      screen.getByText('Everyone with access to customerorg sees this name.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Everything in Sources goes along. To keep one out, remove it first.',
      ),
    ).toBeInTheDocument();
  });

  it('defaults to the company home when one is set, and shares to it', async () => {
    const a = setup({
      'brainHome:get': () => company,
      'brain:share': () => ({ status: 'shared', joinLink: 'shellie://join?x' }),
    });
    render(
      <ShareDialog brain={brainView()} onClose={vi.fn()} onSources={vi.fn()} />,
    );
    expect(
      await screen.findByRole('radio', {
        name: 'Company brain home (acme)',
        checked: true,
      }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:share',
        args: [{ brainId: 'b1', home: 'company', repoName: 'Acme' }],
      }),
    );
    expect(await screen.findByText('shellie://join?x')).toBeInTheDocument();
  });

  it('lists the files that may hold a secret', async () => {
    setup({
      'brain:share': () => ({
        status: 'secrets',
        files: ['sources/a.md', 'wiki/b.md'],
      }),
    });
    render(
      <ShareDialog brain={brainView()} onClose={vi.fn()} onSources={vi.fn()} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }));
    expect(
      await screen.findByText(
        'Possible secrets in these files. Scrub them, then share.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('sources/a.md')).toBeInTheDocument();
    expect(screen.getByText('wiki/b.md')).toBeInTheDocument();
  });

  it('shows Syncing first and asks again when the sync job ends', async () => {
    let n = 0;
    const a = setup({
      'brain:share': () =>
        ++n === 1
          ? { status: 'syncing' }
          : { status: 'shared', joinLink: 'shellie://join?y' },
    });
    const running = brainView({
      jobs: [brainJob({ id: 's', kind: 'sync', status: 'running' })],
    });
    const { rerender } = render(
      <ShareDialog brain={running} onClose={vi.fn()} onSources={vi.fn()} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }));
    expect(await screen.findByText('Syncing first…')).toBeInTheDocument();
    expect(a.calls.filter((c) => c.channel === 'brain:share')).toHaveLength(1);
    rerender(
      <ShareDialog
        brain={brainView({
          jobs: [
            brainJob({
              id: 's',
              kind: 'sync',
              status: 'done',
              endedAt: new Date(Date.now() + 1000).toISOString(),
            }),
          ],
        })}
        onClose={vi.fn()}
        onSources={vi.fn()}
      />,
    );
    expect(await screen.findByText('shellie://join?y')).toBeInTheDocument();
    expect(a.calls.filter((c) => c.channel === 'brain:share')).toHaveLength(2);
  });

  const ended = (status: 'done' | 'failed') =>
    brainView({
      jobs: [
        brainJob({
          id: 's',
          kind: 'sync',
          status,
          endedAt: new Date(Date.now() + 1000).toISOString(),
        }),
      ],
    });
  const syncFirst = async (share: () => unknown) => {
    const a = setup({ 'brain:share': share });
    const { rerender } = render(
      <ShareDialog
        brain={brainView({
          jobs: [brainJob({ id: 's', kind: 'sync', status: 'running' })],
        })}
        onClose={vi.fn()}
        onSources={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }));
    expect(await screen.findByText('Syncing first…')).toBeInTheDocument();
    return { a, rerender };
  };
  const shares = (a: { calls: { channel: string }[] }) =>
    a.calls.filter((c) => c.channel === 'brain:share').length;

  it('does not ask again when the sync fails, and says so', async () => {
    const { a, rerender } = await syncFirst(() => ({ status: 'syncing' }));
    rerender(
      <ShareDialog
        brain={ended('failed')}
        onClose={vi.fn()}
        onSources={vi.fn()}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The sync before sharing failed. Look at the job, then share again.',
    );
    expect(shares(a)).toBe(1);
  });

  it('asks again only once: a second Syncing shows a message, not another sync', async () => {
    const { a, rerender } = await syncFirst(() => ({ status: 'syncing' }));
    rerender(
      <ShareDialog
        brain={ended('done')}
        onClose={vi.fn()}
        onSources={vi.fn()}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The brain changed while it synced. Share again.',
    );
    expect(shares(a)).toBe(2);
    expect(screen.queryByText('Syncing first…')).not.toBeInTheDocument();
  });
});
