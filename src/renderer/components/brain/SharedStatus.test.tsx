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
    [{ status: 'pending' as const }, 'Sending changes'],
    [{ status: 'unreachable' as const }, "Can't reach acme"],
    [
      { status: 'held' as const, heldFile: 'sources/a.md' },
      'Held: possible secret in sources/a.md',
    ],
  ])('says it for %j', (over, expected) => {
    text(over);
    expect(screen.getByRole('status')).toHaveTextContent(expected);
  });
  it('says a capture ran again', () => {
    text({}, { jobs: [brainJob({ kind: 'capture', replays: 1 })] });
    expect(screen.getByRole('status')).toHaveTextContent('Ran a capture again');
  });
  it('says a newer Shellie is around', () => {
    text({}, { newerShellie: true });
    expect(
      screen.getByText("A colleague's Shellie is newer: update Shellie."),
    ).toBeInTheDocument();
  });
});
