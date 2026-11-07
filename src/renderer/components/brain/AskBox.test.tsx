import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { AskBox } from './AskBox';

const def = { id: 'brain-b1', kind: 'opencode' as const, label: 'Acme brain' };

afterEach(cleanup);

describe('AskBox', () => {
  it.each([
    ['claude' as const, '/ask who owns billing?'],
    [
      'opencode' as const,
      'Load the ask skill and answer from this brain, reading only: who owns billing?',
    ],
  ])('asks on %s in its own words', async (agent, prompt) => {
    const a = installFakeApi({ 'brain:terminal': () => def });
    const onTerminal = vi.fn();
    render(
      <AskBox
        brainId="b1"
        agent={agent}
        onTerminal={onTerminal}
        initiallyOpen
      />,
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Question' }),
      'who owns billing?',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onTerminal).toHaveBeenCalledWith(def));
    expect(a.calls).toContainEqual({
      channel: 'brain:terminal',
      args: ['b1', null, prompt],
    });
  });
});
