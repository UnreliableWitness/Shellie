import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SetupSummary } from '../../shared/types';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { TaskSummaryCard } from './TaskSummaryCard';

const summary: SetupSummary = {
  branch: 'feature/48231-show',
  base: 'origin/main',
  copy: ['.env', 'config/local.json'],
  commands: ['npm ci'],
  apm: null,
  tabs: ['Claude Code', 'zsh'],
  run: ['npm run dev'],
  workItem: { move: 'Doing', assign: true },
  editor: 'VS Code',
  brain: null,
};

/** A line of the card by its label (the label text, not an accessible name, so form labels do not clash). */
const summaryLine = (name: string): HTMLElement => {
  const li = screen
    .getByText(name, { selector: '.task-summary-label' })
    .closest('li');
  if (!li) throw new Error(`No line ${name}`);
  return li;
};
const line = summaryLine;

describe('TaskSummaryCard', () => {
  beforeEach(() => {
    installFakeApi();
  });

  it('card lists branch, env, setup and work item', () => {
    render(<TaskSummaryCard summary={summary} repoId="r1" />);
    expect(screen.getByText('This task will…')).toBeInTheDocument();
    expect(line('Branch')).toHaveTextContent(
      'feature/48231-show from origin/main',
    );
    expect(line('Env')).toHaveTextContent('.env');
    expect(line('Env')).toHaveTextContent('config/local.json');
    expect(line('Setup')).toHaveTextContent('npm ci');
    expect(line('Opens')).toHaveTextContent('Claude Code, zsh');
    expect(line('Run')).toHaveTextContent('npm run dev');
    expect(line('Work item')).toHaveTextContent('Move to Doing, assign to me');
    expect(line('Editor')).toHaveTextContent('VS Code');
  });

  it('says unchanged when the work item is left alone', () => {
    render(
      <TaskSummaryCard
        summary={{ ...summary, workItem: { move: null, assign: false } }}
        repoId="r1"
      />,
    );
    expect(line('Work item')).toHaveTextContent('Unchanged');
  });

  it('Edit link opens Settings on the repo category', async () => {
    render(<TaskSummaryCard summary={summary} repoId="r1" />);
    await userEvent.click(
      within(line('Env')).getByRole('button', { name: 'Edit Env' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      repoId: 'r1',
      section: 'repo-secrets',
    });
    await userEvent.click(
      within(line('Work item')).getByRole('button', {
        name: 'Edit Work item',
      }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      repoId: 'r1',
      section: 'repo-workitems',
    });
    await userEvent.click(
      within(line('Opens')).getByRole('button', { name: 'Edit Opens' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'settings',
      section: 'terminals',
    });
  });

  it('missing env file shows a warning line', () => {
    render(
      <TaskSummaryCard
        summary={summary}
        repoId="r1"
        copyStates={[
          { path: '.env', state: 'present', folder: false },
          { path: 'config/local.json', state: 'missing', folder: false },
        ]}
      />,
    );
    const warnings = within(line('Env')).getAllByRole('alert');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toHaveTextContent(
      'config/local.json is missing in the main checkout',
    );
  });

  it('collapses when collapsible and opens on click', async () => {
    render(<TaskSummaryCard summary={summary} repoId="r1" collapsible />);
    expect(screen.queryByText('Branch')).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: /This task will…/ }),
    );
    expect(line('Branch')).toBeInTheDocument();
  });
});
