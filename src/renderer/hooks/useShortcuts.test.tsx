import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContributeCommands } from '../commands/registry';
import type { Command } from '../commands/types';
import { useStore } from '../store';
import { useShortcuts } from './useShortcuts';

function Host({ commands = [] }: { commands?: Command[] }) {
  useShortcuts();
  useContributeCommands('test', commands);
  return null;
}
/** A key with the mod key of the test platform (not a Mac). Returns whether the default was prevented. */
const press = (code: string, shiftKey = false) =>
  !fireEvent.keyDown(window, { code, ctrlKey: true, shiftKey });

describe('useShortcuts', () => {
  beforeEach(() => {
    useStore.setState({
      paletteOpen: false,
      focus: false,
      tasks: [],
      connections: [],
      repos: [],
    });
  });

  it('opens the palette on Mod+Shift+P and closes it on the next', () => {
    render(<Host />);
    expect(press('KeyP', true)).toBe(true);
    expect(useStore.getState().paletteOpen).toBe(true);
    press('KeyP', true);
    expect(useStore.getState().paletteOpen).toBe(false);
  });

  it('runs the command whose shortcut it is, and takes the key', () => {
    const run = vi.fn();
    const docs: Command = {
      id: 'task.docs',
      title: 'Show docs',
      group: 'task',
      shortcut: { code: 'KeyD', shift: true },
      run,
    };
    render(<Host commands={[docs]} />);
    expect(press('KeyD', true)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('leaves a key no command has alone', () => {
    render(<Host />);
    expect(press('KeyD', true)).toBe(false);
    expect(press('Digit1')).toBe(false);
  });

  it('toggles Focus on Mod+Shift+F', () => {
    render(<Host />);
    press('KeyF', true);
    expect(useStore.getState().focus).toBe(true);
  });

  it('runs no other shortcut while the palette is open', () => {
    const run = vi.fn();
    const one: Command = {
      id: 'task.terminal.1',
      title: 'Switch to terminal 1',
      group: 'task',
      shortcut: { code: 'Digit1' },
      run,
    };
    render(<Host commands={[one]} />);
    useStore.setState({ paletteOpen: true });
    press('Digit1');
    expect(run).not.toHaveBeenCalled();
  });
});
