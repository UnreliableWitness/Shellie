import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useContributeCommands } from '../commands/registry';
import type { Command } from '../commands/types';
import { TaskBarMenu } from './TaskBarMenu';

const noop = () => undefined;
const COMMANDS: Command[] = [
  { id: 'task.usage', title: 'Usage', group: 'task', run: noop },
  { id: 'task.finish', title: 'Finish task', group: 'task', run: noop },
  {
    id: 'task.discard',
    title: 'Discard task',
    group: 'task',
    danger: true,
    run: noop,
  },
];

function Offer() {
  useContributeCommands('test', COMMANDS);
  return null;
}

describe('TaskBarMenu', () => {
  it('sets Discard apart from Finish: a separator between them and the danger colour', async () => {
    render(
      <>
        <Offer />
        <TaskBarMenu where={['task/x']} dots={{}} visible onOpen={noop} />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Task menu' }));
    const finish = screen.getByRole('menuitem', { name: 'Finish task' });
    const discard = screen.getByRole('menuitem', { name: 'Discard task' });
    expect(finish.nextElementSibling).toHaveAttribute('role', 'separator');
    expect(finish.nextElementSibling?.nextElementSibling).toBe(discard);
    expect(discard).toHaveClass('is-danger');
    expect(finish).not.toHaveClass('is-danger');
  });
});
