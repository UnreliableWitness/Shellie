import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AskStep } from '../../../shared/askProgress';
import { AskSteps, AskStepsFold } from './AskSteps';

afterEach(cleanup);

const steps: AskStep[] = [
  { kind: 'search', label: 'Searched for “retry”' },
  { kind: 'read', label: 'Read wiki/a.md' },
];

describe('AskSteps', () => {
  it('lists the steps in order, after a line for the ones no longer kept', () => {
    render(<AskSteps steps={steps} earlier={12} />);
    const items = within(
      screen.getByRole('list', { name: 'What the agent did' }),
    ).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      '12 earlier steps',
      'Searched for “retry”',
      'Read wiki/a.md',
    ]);
  });
  it('is nothing without steps', () => {
    const { container } = render(<AskSteps steps={[]} earlier={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AskStepsFold', () => {
  it('keeps the steps of a finished ask behind their count', async () => {
    render(<AskStepsFold steps={steps} />);
    const summary = screen.getByText('2 steps');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Read wiki/a.md')).toBeInTheDocument();
  });
  it('says one step in the singular, and is nothing without steps', () => {
    const { container, rerender } = render(<AskStepsFold steps={[steps[0]]} />);
    expect(screen.getByText('1 step')).toBeInTheDocument();
    rerender(<AskStepsFold steps={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AskStepsFold steps={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
