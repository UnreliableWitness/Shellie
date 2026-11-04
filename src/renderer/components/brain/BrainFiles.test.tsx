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

describe('BrainFiles sources', () => {
  it('removes a source after a confirmation, never a wiki mirror page', async () => {
    const a = installFakeApi({
      'brain:files': () => [
        { path: 'sources/2026-11-04-deck.md', changed: null },
        { path: 'sources/wiki/Page.md', changed: null },
      ],
      'brain:sources': () => [],
      'brain:read': () => ({ text: '# Deck\n' }),
    });
    render(<BrainFiles brainId="b1" dir="sources" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'sources/wiki/Page.md' }),
    );
    await screen.findByRole('status', {}, { timeout: 500 }).catch(() => null);
    expect(screen.queryByRole('button', { name: 'Remove…' })).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'sources/2026-11-04-deck.md' }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove…' }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Remove sources/2026-11-04-deck.md?',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove source' }),
    );
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:removeSource',
        args: ['b1', 'sources/2026-11-04-deck.md'],
      }),
    );
  });
});
