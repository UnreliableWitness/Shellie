import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { BrainFiles } from './BrainFiles';

const page = (verified: string | null) =>
  `---\ntitle: Acme\nsummary: Who.\nlast_updated: 2026-11-03\nconfidence: high\n${verified ? `verified: ${verified}\n` : ''}---\n\n# Acme\n\nWho.\n`;

describe('BrainFiles', () => {
  it('shows when a wiki page was verified and lets a person mark it', async () => {
    let text = page('2026-11-01');
    const a = installFakeApi({
      'brain:files': () => [{ path: 'wiki/account.md', changed: null }],
      'brain:read': () => ({ text }),
      'brain:verify': () => {
        text = page('2026-11-04');
        return { verified: '2026-11-04' };
      },
    });
    render(<BrainFiles brainId="b1" dir="wiki" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'wiki/account.md' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Verified 2026-11-01, changed since (2026-11-03) · confidence high',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Verify again' }));
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:verify',
        args: ['b1', 'wiki/account.md'],
      }),
    );
    expect(await screen.findByText(/^Verified 2026-11-04/)).toBeInTheDocument();
  });

  it('says when nobody verified a page yet, and shows nothing for sources', async () => {
    installFakeApi({
      'brain:files': () => [{ path: 'wiki/a.md', changed: null }],
      'brain:read': () => ({ text: page(null) }),
    });
    render(<BrainFiles brainId="b1" dir="wiki" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'wiki/a.md' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Not verified by anyone yet · confidence high',
    );
    expect(
      screen.getByRole('button', { name: 'Mark verified' }),
    ).toBeInTheDocument();
  });
});
