import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store';
import { allCommands, useContributeCommands } from './registry';
import type { Command } from './types';

const cmd = (id: string, group: Command['group'] = 'task'): Command => ({
  id,
  title: id,
  group,
  run: () => undefined,
});

function Offer({ source, commands }: { source: string; commands: Command[] }) {
  useContributeCommands(source, commands);
  return null;
}
const ids = () => allCommands().map((c) => c.id);

describe('the command registry', () => {
  beforeEach(() => {
    useStore.setState({ connections: [], tasks: [], repos: [] });
  });

  it("holds a mounted component's commands and drops them when it goes", () => {
    const a = [cmd('a')];
    const { rerender, unmount } = render(<Offer source="x" commands={a} />);
    expect(ids()).toContain('a');
    rerender(<Offer source="x" commands={[cmd('b')]} />);
    expect(ids()).toContain('b');
    expect(ids()).not.toContain('a');
    unmount();
    expect(ids()).not.toContain('b');
  });

  it('withdraws on an empty list', () => {
    const { rerender } = render(<Offer source="x" commands={[cmd('a')]} />);
    rerender(<Offer source="x" commands={[]} />);
    expect(ids()).not.toContain('a');
  });

  it('keeps a command marked last at the end of its group', () => {
    render(
      <>
        <Offer source="a" commands={[{ ...cmd('end'), last: true }]} />
        <Offer source="b" commands={[cmd('later')]} />
      </>,
    );
    const task = ids().filter((id) => id === 'end' || id === 'later');
    expect(task).toEqual(['later', 'end']);
  });

  it('keeps a source in its place when it offers a new list', () => {
    const two = [cmd('b')];
    const { rerender } = render(
      <>
        <Offer source="one" commands={[cmd('a')]} />
        <Offer source="two" commands={two} />
      </>,
    );
    rerender(
      <>
        <Offer source="one" commands={[cmd('a2')]} />
        <Offer source="two" commands={two} />
      </>,
    );
    const mine = ids().filter((id) => ['a2', 'b'].includes(id));
    expect(mine).toEqual(['a2', 'b']);
  });

  it("puts the task bar's own commands before the rest of the task's, whoever offered first", () => {
    render(
      <>
        <Offer source="task.editor" commands={[cmd('editor')]} />
        <Offer source="task" commands={[cmd('tabs')]} />
      </>,
    );
    const mine = ids().filter((id) => ['editor', 'tabs'].includes(id));
    expect(mine).toEqual(['tabs', 'editor']);
  });

  it('orders by group whatever was offered first', () => {
    render(
      <>
        <Offer source="late" commands={[cmd('z.app', 'app')]} />
        <Offer source="x" commands={[cmd('a.task', 'task')]} />
      </>,
    );
    const all = ids();
    expect(all.indexOf('a.task')).toBe(0);
    expect(all.indexOf('a.task')).toBeLessThan(all.indexOf('goto.home'));
    expect(all.indexOf('goto.home')).toBeLessThan(all.indexOf('z.app'));
  });
});
