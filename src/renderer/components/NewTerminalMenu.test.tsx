import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NewTerminalMenu } from './NewTerminalMenu';

describe('NewTerminalMenu with several repos', () => {
  it('asks for the repo after the terminal type', async () => {
    const onOpen = vi.fn();
    render(
      <NewTerminalMenu
        workspaces={[
          { id: 'home', name: 'webshop' },
          { id: 'w1', name: 'api' },
        ]}
        onOpen={onOpen}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Shell' }));
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('menuitem', { name: 'api' }));
    expect(onOpen).toHaveBeenCalledWith({
      kind: 'shell',
      label: 'shell',
      workspaceId: 'w1',
    });
  });

  it('opens straight away with one repo', async () => {
    const onOpen = vi.fn();
    render(
      <NewTerminalMenu
        workspaces={[{ id: 'home', name: 'webshop' }]}
        onOpen={onOpen}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Shell' }));
    expect(onOpen).toHaveBeenCalledWith({ kind: 'shell', label: 'shell' });
  });
});

describe('NewTerminalMenu', () => {
  it('lists OpenCode without a note that its cost is not tracked', async () => {
    render(<NewTerminalMenu onOpen={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(screen.getByRole('menuitem', { name: 'OpenCode' })).toBeTruthy();
    expect(screen.queryByText(/not tracked/)).toBeNull();
  });
});

describe('NewTerminalMenu with a brain', () => {
  it('offers a Brain terminal that does not go through onOpen', async () => {
    const onOpen = vi.fn();
    const onOpenBrain = vi.fn();
    render(
      <NewTerminalMenu
        brain={{ id: 'b1', name: 'Acme' }}
        onOpen={onOpen}
        onOpenBrain={onOpenBrain}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(screen.getByText('Acme')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('menuitem', { name: /Brain terminal/ }),
    );
    expect(onOpenBrain).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('has no Brain terminal without a brain', async () => {
    render(<NewTerminalMenu onOpen={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(
      screen.queryByRole('menuitem', { name: /Brain terminal/ }),
    ).toBeNull();
  });
});
