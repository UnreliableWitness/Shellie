import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BrainSharing } from '../../../shared/brain';
import { brainJob, brainView } from '../../test-helpers/brainFixture';
import { SharedStatus } from './SharedStatus';

const sharing = (over: Partial<BrainSharing>): BrainSharing => ({
  home: 'company',
  remoteUrl: 'https://dev.azure.com/acme/Brains/_git/x',
  repositoryId: 'r',
  homeOrganizationUrl: 'https://dev.azure.com/acme',
  homeProject: 'Brains',
  joinedAt: '2026-11-13T09:00:00.000Z',
  lastPullAt: null,
  lastPushAt: null,
  status: 'ok',
  heldFile: null,
  ...over,
});
const text = (over: Partial<BrainSharing>, brain = {}) => {
  render(
    <SharedStatus brain={brainView({ sharing: sharing(over), ...brain })} />,
  );
};

describe('SharedStatus', () => {
  it('shows nothing for a local brain', () => {
    const { container } = render(<SharedStatus brain={brainView()} />);
    expect(container).toBeEmptyDOMElement();
  });
  it.each([
    [{ status: 'ok' as const }, 'Shared · up to date'],
    [{ status: 'pending' as const, ahead: 3 }, 'Sending 3 changes'],
    [{ status: 'pending' as const, ahead: 1 }, 'Sending 1 change'],
    [
      { status: 'unreachable' as const, ahead: 3 },
      "Can't reach acme · 3 changes waiting",
    ],
    [{ status: 'unauthorized' as const }, "Can't sign in to acme"],
    [
      { status: 'held' as const, heldFile: 'sources/a.md' },
      'Held: possible secret in sources/a.md',
    ],
    [
      { status: 'held' as const, heldReason: 'unchecked' as const },
      "Held: the changes couldn't be checked for secrets",
    ],
  ])('says it for %j', (over, expected) => {
    text(over);
    expect(screen.getByRole('status')).toHaveTextContent(expected);
  });
  it('says a capture ran again while it is running, or within the hour', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    for (const job of [
      brainJob({
        kind: 'capture',
        replays: 1,
        status: 'running',
        endedAt: null,
      }),
      brainJob({
        kind: 'capture',
        replays: 1,
        status: 'done',
        endedAt: ago(60_000),
      }),
    ]) {
      const { unmount } = render(
        <SharedStatus
          brain={brainView({ sharing: sharing({}), jobs: [job] })}
        />,
      );
      expect(screen.getByRole('status')).toHaveTextContent(
        'Ran a capture again',
      );
      unmount();
    }
  });
  it('stops saying it an hour after the capture ended, and for jobs that did not replay', () => {
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    text(
      {},
      {
        jobs: [
          brainJob({
            kind: 'capture',
            replays: 1,
            status: 'done',
            endedAt: old,
          }),
          brainJob({
            id: 'j2',
            kind: 'capture',
            replays: 0,
            status: 'running',
            endedAt: null,
          }),
        ],
      },
    );
    expect(screen.getByRole('status')).not.toHaveTextContent(
      'Ran a capture again',
    );
  });
  it('says a newer Shellie is around', () => {
    text({}, { newerShellie: true });
    expect(
      screen.getByText("A colleague's Shellie is newer: update Shellie."),
    ).toBeInTheDocument();
  });
});
