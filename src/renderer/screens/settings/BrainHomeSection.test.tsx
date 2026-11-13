import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { BrainHomeSection } from './BrainHomeSection';

describe('BrainHomeSection', () => {
  it('saves the company brain home', async () => {
    const a = installFakeApi({
      'brainHome:get': () => null,
      'brainHome:save': (input) => ({ ...input, user: 'D' }),
    });
    render(<BrainHomeSection />);
    await userEvent.type(
      await screen.findByLabelText('Organization URL'),
      'https://dev.azure.com/acme',
    );
    await userEvent.type(screen.getByLabelText('Project'), 'Brains');
    await userEvent.type(screen.getByLabelText('Token'), 'pat');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brainHome:save',
        args: [
          {
            organizationUrl: 'https://dev.azure.com/acme',
            project: 'Brains',
            pat: 'pat',
          },
        ],
      }),
    );
    expect(await screen.findByText(/acme\/Brains/)).toBeInTheDocument();
  });
  it('removes a saved home', async () => {
    const a = installFakeApi({
      'brainHome:get': () => ({
        organizationUrl: 'https://dev.azure.com/acme',
        project: 'Brains',
        user: 'D',
      }),
      'brainHome:remove': () => undefined,
    });
    render(<BrainHomeSection />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove' }),
    );
    await waitFor(() =>
      expect(a.calls.map((c) => c.channel)).toContain('brainHome:remove'),
    );
    expect(
      await screen.findByLabelText('Organization URL'),
    ).toBeInTheDocument();
  });
});
