import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SourceBar } from './SourceBar';

const warning = /This brain is shared\. The server keeps what was already sent/;
describe('SourceBar', () => {
  it('warns on a shared brain when removing', async () => {
    render(<SourceBar path="sources/a.md" shared onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove…' }));
    expect(screen.getByText(warning)).toBeInTheDocument();
  });
  it('does not warn on a local brain', async () => {
    render(<SourceBar path="sources/a.md" onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove…' }));
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });
});
