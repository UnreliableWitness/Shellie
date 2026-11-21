import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultDreaming } from '../../../shared/dreams';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { projectOf } from '../../test-helpers/project';
import { DreamingSection } from './DreamingSection';

const section = (id = 'p2') => (
  <DreamingSection connection={projectOf(id)} title="Dreaming" />
);

beforeEach(() => {
  useStore.setState({ screen: { kind: 'settings' }, previous: null });
});

describe('DreamingSection', () => {
  it('shows the state, model and limit, and opens Dreams', async () => {
    const { calls } = installFakeApi({
      'dream:get': () => ({
        settings: {
          ...defaultDreaming(),
          enabled: true,
          model: 'zai/glm-5.3',
          limit: { kind: 'tokens', perDay: 5_000_000 },
        },
        models: null,
        euroLimitOffered: false,
        usage: { day: '2026-11-20', tokens: 0, eur: 0 },
        waiting: null,
        next: null,
        running: null,
        switchedOff: null,
        repos: [],
        journal: [],
      }),
    });
    render(section());
    expect(await screen.findByText('Dreaming is on')).toBeInTheDocument();
    expect(screen.getByText('zai/glm-5.3')).toBeInTheDocument();
    expect(screen.getByText(/5 000 000 tokens a day/)).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2); // the row's gear and Open Dreams
    await userEvent.click(screen.getByRole('button', { name: 'Open Dreams' }));
    expect(useStore.getState().screen).toEqual({ kind: 'dreams' });
    // The picked project's dreams were read, and Dreams opens on that project.
    expect(calls.filter((c) => c.channel === 'dream:get')[0].args).toEqual([
      'p2',
    ]);
    expect(useStore.getState().connectionId).toBe('p2');
  });

  it('says dreaming is off with nothing chosen', async () => {
    installFakeApi();
    render(section());
    expect(await screen.findByText('Dreaming is off')).toBeInTheDocument();
    expect(screen.getByText('Limit: Not chosen')).toBeInTheDocument();
  });
});
