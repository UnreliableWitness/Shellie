import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { TimeSection } from './TimeSection';

beforeEach(() => useStore.setState({ notices: [] }));

describe('TimeSection', () => {
  it('refuses working hours that end before they start', async () => {
    const { calls } = installFakeApi({ 'settings:save': (s) => s });
    render(<TimeSection />);
    const end = await screen.findByLabelText('Working hours end');
    await userEvent.clear(end);
    await userEvent.type(end, '08:00');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/after/);
    expect(calls.some((c) => c.channel === 'settings:save')).toBe(false);
  });
});
