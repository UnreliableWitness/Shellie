import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContributeCommands } from '../commands/registry';
import type { Command } from '../commands/types';
import { useStore } from '../store';
import { CommandPalette } from './CommandPalette';

const open = () => act(() => useStore.getState().setPaletteOpen(true));
const field = () => screen.getByRole('combobox', { name: 'Go to or run' });
const rows = () => screen.getAllByRole('option').map((o) => o.textContent);

function Offer({ commands }: { commands: Command[] }) {
  useContributeCommands('test', commands);
  return null;
}

describe('CommandPalette', () => {
  beforeEach(() => {
    useStore.setState({
      screen: { kind: 'home' },
      paletteOpen: false,
      connections: [],
      connectionId: null,
      tasks: [],
      repos: [],
    });
  });

  it('shows nothing until it is opened', () => {
    render(<CommandPalette />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on its field, with the commands under their group headings', () => {
    render(<CommandPalette />);
    open();
    expect(field()).toHaveFocus();
    expect(screen.getByText('Go to')).toBeInTheDocument();
    expect(rows()[0]).toContain('Home');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('filters as you type, best match first, without headings', async () => {
    render(<CommandPalette />);
    open();
    await userEvent.type(field(), 'spr');
    expect(rows()[0]).toContain('Sprint');
    expect(screen.queryByText('Go to')).toBeNull();
  });

  it('runs the selected command on Enter and closes', async () => {
    render(<CommandPalette />);
    open();
    await userEvent.type(field(), 'spr{Enter}');
    expect(useStore.getState().screen.kind).toBe('sprint');
    expect(useStore.getState().paletteOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks a command that destroys in the danger colour', () => {
    const noop = () => undefined;
    render(
      <>
        <Offer
          commands={[
            {
              id: 'task.finish',
              title: 'Finish task',
              group: 'task',
              run: noop,
            },
            {
              id: 'task.discard',
              title: 'Discard task',
              group: 'task',
              danger: true,
              run: noop,
            },
          ]}
        />
        <CommandPalette />
      </>,
    );
    open();
    expect(screen.getByRole('option', { name: /Discard task/ })).toHaveClass(
      'is-danger',
    );
    expect(screen.getByRole('option', { name: /Finish task/ })).not.toHaveClass(
      'is-danger',
    );
  });

  it('runs a clicked command', async () => {
    render(<CommandPalette />);
    open();
    await userEvent.click(screen.getByRole('option', { name: /Week/ }));
    expect(useStore.getState().screen.kind).toBe('week');
  });

  it('closes on Escape and gives focus back', async () => {
    render(
      <>
        <button type="button">before</button>
        <CommandPalette />
      </>,
    );
    screen.getByText('before').focus();
    open();
    await userEvent.keyboard('{Escape}');
    expect(useStore.getState().paletteOpen).toBe(false);
    expect(screen.getByText('before')).toHaveFocus();
  });

  it('closes on a click outside', () => {
    render(<CommandPalette />);
    open();
    fireEvent.mouseDown(screen.getByTestId('palette-backdrop'));
    expect(useStore.getState().paletteOpen).toBe(false);
  });

  it('wraps from the first row to the last', async () => {
    render(<CommandPalette />);
    open();
    await userEvent.keyboard('{ArrowUp}');
    const all = screen.getAllByRole('option');
    expect(all.at(-1)).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    expect(all[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('says so when nothing matches, and Enter then does nothing', async () => {
    render(<CommandPalette />);
    open();
    await userEvent.type(field(), 'zzz{Enter}');
    expect(screen.getByText('No match')).toBeInTheDocument();
    expect(useStore.getState().paletteOpen).toBe(true);
    expect(useStore.getState().screen.kind).toBe('home');
  });

  it('shows a note, or else the shortcut', () => {
    const commands: Command[] = [
      {
        id: 'a',
        title: 'Alpha',
        group: 'task',
        note: '3 files',
        run: () => undefined,
      },
      {
        id: 'b',
        title: 'Beta',
        group: 'task',
        shortcut: { code: 'KeyD', shift: true },
        run: () => undefined,
      },
    ];
    render(
      <>
        <Offer commands={commands} />
        <CommandPalette />
      </>,
    );
    open();
    expect(screen.getByText('This task')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Alpha/ })).toHaveTextContent(
      '3 files',
    );
    expect(screen.getByRole('option', { name: /Beta/ })).toHaveTextContent(
      /(Ctrl|Cmd)\+Shift\+D/,
    );
  });

  it('survives a command withdrawn while it is open', async () => {
    const run = vi.fn();
    const commands: Command[] = [
      { id: 'a', title: 'Alpha', group: 'task', run },
    ];
    const { rerender } = render(
      <>
        <Offer commands={commands} />
        <CommandPalette />
      </>,
    );
    open();
    expect(rows()[0]).toContain('Alpha');
    rerender(
      <>
        <CommandPalette />
      </>,
    );
    expect(rows().join(' ')).not.toContain('Alpha');
    await userEvent.keyboard('{Enter}');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the selection on its command when a row appears above it', async () => {
    const run = vi.fn();
    const mine: Command = { id: 'mine', title: 'Mine', group: 'goto', run };
    const above: Command = {
      id: 'above',
      title: 'Above',
      group: 'task',
      run: vi.fn(),
    };
    function Late({ on }: { on: boolean }) {
      useContributeCommands('late', on ? [above] : []);
      return null;
    }
    const late = [above];
    void late;
    const { rerender } = render(
      <>
        <Offer commands={[mine]} />
        <Late on={false} />
        <CommandPalette />
      </>,
    );
    open();
    const selected = () =>
      screen
        .getAllByRole('option')
        .find((o) => o.getAttribute('aria-selected') === 'true')?.textContent;
    while (selected() !== 'Mine') await userEvent.keyboard('{ArrowDown}');
    rerender(
      <>
        <Offer commands={[mine]} />
        <Late on />
        <CommandPalette />
      </>,
    );
    expect(rows()[0]).toContain('Above');
    expect(selected()).toBe('Mine');
    await userEvent.keyboard('{Enter}');
    expect(run).toHaveBeenCalledTimes(1);
    expect(above.run).not.toHaveBeenCalled();
  });

  it('keeps the focus on its field: Tab stays, and a click on its own chrome does not blur it', async () => {
    render(
      <>
        <button type="button">behind</button>
        <CommandPalette />
      </>,
    );
    open();
    await userEvent.tab();
    expect(field()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(field()).toHaveFocus();
    const foot = screen.getByText(/Esc to close/);
    expect(fireEvent.mouseDown(foot)).toBe(false);
  });

  it('keeps its key presses to itself', async () => {
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    render(<CommandPalette />);
    open();
    await userEvent.type(field(), 'a');
    window.removeEventListener('keydown', outside);
    expect(outside).not.toHaveBeenCalled();
  });
});
