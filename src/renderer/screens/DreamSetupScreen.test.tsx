import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  confirmSentence,
  defaultDreaming,
  type DreamingSettings,
  type DreamView,
} from '../../shared/dreams';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { DreamSetupScreen } from './DreamSetupScreen';

const MODEL = 'zai/glm-5.3';

const ready = (patch: Partial<DreamingSettings> = {}): DreamingSettings => ({
  ...defaultDreaming(),
  model: MODEL,
  testedModel: MODEL,
  limit: { kind: 'tokens', perDay: 5_000_000 },
  repos: { r1: { on: true, folders: ['.apm'] } },
  ...patch,
});

const state = {
  covered: {},
  sightings: [],
  rejections: [],
  failures: 0,
  lastFailureAt: null,
  lastFailure: null,
  lastDreamAt: null,
  lastOutcome: null,
  result: null,
};

const viewOf = (
  settings: DreamingSettings,
  patch: Partial<DreamView> = {},
): DreamView => ({
  settings,
  models: [MODEL, 'opencode/big-pickle'],
  euroLimitOffered: false,
  usage: { day: '2026-11-20', tokens: 0, eur: 0 },
  waiting: null,
  next: null,
  running: null,
  switchedOff: null,
  repos: [
    {
      id: 'r1',
      name: 'portal',
      suggestedFolders: ['.apm'],
      newSessions: 0,
      state,
    },
    {
      id: 'r2',
      name: 'billing',
      suggestedFolders: ['.apm'],
      newSessions: 0,
      state,
    },
    { id: 'r3', name: 'intranet', suggestedFolders: [], newSessions: 0, state },
  ],
  journal: [],
  ...patch,
});

const open = (
  view: DreamView,
  extra: Parameters<typeof installFakeApi>[0] = {},
) => installFakeApi({ 'dream:get': () => view, ...extra });

const callsOf = (
  calls: { channel: string; args: unknown[] }[],
  channel: string,
) => calls.filter((c) => c.channel === channel).map((c) => c.args);

const tick = () => screen.getByRole('checkbox', { name: /I have read this/ });
const switchOn = () =>
  screen.getByRole('button', { name: 'Switch on dreaming' });
const panel = () =>
  screen.getByRole('complementary', { name: 'What you are switching on' });

beforeEach(() => {
  useStore.setState({
    screen: { kind: 'dream-setup' },
    previous: null,
    notices: [],
  });
});

describe('DreamSetupScreen: switching on', () => {
  it.each([
    [{ model: null, testedModel: null }, /Choose a model/],
    [{ testedModel: null }, /Test the model/],
    [{ limit: null }, /how much it may spend/],
    [{ repos: {} }, /Tick a repo/],
  ] as const)('is disabled and says why: %j', async (patch, reason) => {
    open(viewOf(ready(patch)));
    render(<DreamSetupScreen />);
    await screen.findByRole('heading', { name: 'What you are switching on' });
    expect(switchOn()).toBeDisabled();
    expect(within(panel()).getByText(reason)).toBeInTheDocument();
  });

  it('is disabled with all four done until the box is ticked, and the box starts empty', async () => {
    open(viewOf(ready()));
    render(<DreamSetupScreen />);
    await screen.findByText(/Dreams run on OpenCode/);
    expect(tick()).not.toBeChecked();
    expect(switchOn()).toBeDisabled();
    await userEvent.click(tick());
    expect(switchOn()).toBeEnabled();
  });

  it('starts every mount with the box unticked', async () => {
    open(viewOf(ready()));
    const first = render(<DreamSetupScreen />);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: /I have read this/ }),
    );
    first.unmount();
    render(<DreamSetupScreen />);
    expect(
      await screen.findByRole('checkbox', { name: /I have read this/ }),
    ).not.toBeChecked();
  });

  it('shows the exact sentence and updates it when the limit or a repo changes', async () => {
    open(viewOf(ready()));
    render(<DreamSetupScreen />);
    expect(
      await screen.findByText(confirmSentence(ready(), ['portal'])),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'billing' }));
    expect(
      await screen.findByText(
        confirmSentence(
          ready({
            repos: {
              r1: { on: true, folders: ['.apm'] },
              r2: { on: true, folders: ['.apm'] },
            },
          }),
          ['portal', 'billing'],
        ),
      ),
    ).toBeInTheDocument();
    const tokens = screen.getByLabelText('Tokens a day');
    await userEvent.clear(tokens);
    await userEvent.type(tokens, '2.000.000{Enter}');
    expect(
      await screen.findByText(/up to 2 million tokens a day/),
    ).toBeInTheDocument();
    expect(tokens).toHaveValue('2 000 000');
  });

  it('ticking is blocked for a repo with no folder', async () => {
    open(viewOf(ready()));
    render(<DreamSetupScreen />);
    expect(
      await screen.findByRole('checkbox', { name: 'intranet' }),
    ).toBeDisabled();
    expect(screen.getByText(/No agent packages found/)).toBeInTheDocument();
  });

  it('calls dream:switchOn(true) and shows a refusal in words', async () => {
    const a = open(viewOf(ready()), {
      'dream:switchOn': () => {
        throw new Error('Test the model first.');
      },
    });
    render(<DreamSetupScreen />);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: /I have read this/ }),
    );
    await userEvent.click(switchOn());
    expect(callsOf(a.calls, 'dream:switchOn')).toEqual([[true]]);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Test the model first.',
    );
  });
});

describe('DreamSetupScreen: changes while off and on', () => {
  it('saves at once while dreaming is off', async () => {
    const a = open(viewOf(ready()));
    render(<DreamSetupScreen />);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'billing' }),
    );
    await waitFor(() => expect(callsOf(a.calls, 'dream:save')).toHaveLength(1));
    expect(callsOf(a.calls, 'dream:save')[0][1]).toBe(false);
  });

  it('holds a widening change while on until the sentence is confirmed', async () => {
    const a = open(viewOf(ready({ enabled: true })));
    render(<DreamSetupScreen />);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'billing' }),
    );
    const confirm = await screen.findByRole('button', {
      name: 'Confirm the change',
    });
    expect(callsOf(a.calls, 'dream:save')).toHaveLength(0);
    expect(tick()).not.toBeChecked();
    expect(confirm).toBeDisabled();
    expect(
      screen.getByRole('heading', { name: 'Confirm the change' }),
    ).toHaveFocus();
    await userEvent.click(tick());
    await userEvent.click(confirm);
    const next = ready({
      enabled: true,
      repos: {
        r1: { on: true, folders: ['.apm'] },
        r2: { on: true, folders: ['.apm'] },
      },
    });
    await waitFor(() =>
      expect(callsOf(a.calls, 'dream:save')).toEqual([[next, true]]),
    );
  });

  it('saves nothing when the screen is left with a change unconfirmed, and Undo drops it', async () => {
    const a = open(viewOf(ready({ enabled: true })));
    const { unmount } = render(<DreamSetupScreen />);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'billing' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('checkbox', { name: 'billing' })).not.toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: 'billing' }));
    unmount();
    expect(callsOf(a.calls, 'dream:save')).toHaveLength(0);
  });

  it('saves a narrowing change at once while on', async () => {
    const a = open(viewOf(ready({ enabled: true })));
    render(<DreamSetupScreen />);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'portal' }),
    );
    await waitFor(() =>
      expect(callsOf(a.calls, 'dream:save')).toEqual([
        [
          ready({
            enabled: true,
            repos: { r1: { on: false, folders: ['.apm'] } },
          }),
          false,
        ],
      ]),
    );
  });

  it('asks twice for "No limit", naming the model', async () => {
    const a = open(viewOf(ready()));
    render(<DreamSetupScreen />);
    await userEvent.click(
      await screen.findByRole('radio', { name: 'No limit' }),
    );
    expect(
      screen.getByText(`Dreams may spend without a limit on ${MODEL}.`),
    ).toBeInTheDocument();
    expect(callsOf(a.calls, 'dream:save')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Use no limit' }));
    await waitFor(() =>
      expect(callsOf(a.calls, 'dream:save')).toEqual([
        [ready({ limit: { kind: 'none' } }), false],
      ]),
    );
  });
});

describe('DreamSetupScreen: steps', () => {
  it('disables the euro row with the reason when the model has no price', async () => {
    open(viewOf(ready()));
    render(<DreamSetupScreen />);
    expect(await screen.findByRole('radio', { name: 'Euros' })).toBeDisabled();
    expect(
      screen.getByText(`Not available: Shellie has no price for ${MODEL}`),
    ).toBeInTheDocument();
  });

  it('reads "OpenCode was not found" without a model list', async () => {
    open(viewOf(ready(), { models: null }));
    render(<DreamSetupScreen />);
    expect(
      await screen.findByText('OpenCode was not found'),
    ).toBeInTheDocument();
  });

  it('clears Tested when another model is picked, until it is tested', async () => {
    const a = open(viewOf(ready()));
    render(<DreamSetupScreen />);
    expect(await screen.findByText('Tested')).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByLabelText(/Model, from OpenCode/),
      'opencode/big-pickle',
    );
    expect(screen.queryByText('Tested')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(callsOf(a.calls, 'dream:test')).toEqual([['opencode/big-pickle']]);
    expect(
      await screen.findByText(/opencode\/big-pickle answered/),
    ).toBeInTheDocument();
    expect(screen.getByText('Tested')).toBeInTheDocument();
  });

  it('shows progress and cannot be pressed twice while a test runs', async () => {
    let finish: (v: { ok: true }) => void = () => undefined;
    const a = open(viewOf(ready({ testedModel: null })), {
      'dream:test': () => new Promise((r) => (finish = r)),
    });
    render(<DreamSetupScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
    const busy = screen.getByRole('button', { name: /Testing/ });
    expect(busy).toBeDisabled();
    await userEvent.click(busy);
    expect(callsOf(a.calls, 'dream:test')).toHaveLength(1);
    await act(async () => finish({ ok: true }));
    expect(
      await screen.findByText(`${MODEL} answered.`, { exact: false }),
    ).toBeInTheDocument();
  });

  it('shows a failed test message', async () => {
    open(viewOf(ready({ testedModel: null })), {
      'dream:test': () => ({ ok: false, message: 'No answer from the model.' }),
    });
    render(<DreamSetupScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No answer from the model.',
    );
  });

  it('warns that dreaming switches off when another model is picked while on', async () => {
    open(viewOf(ready({ enabled: true })));
    render(<DreamSetupScreen />);
    await userEvent.selectOptions(
      await screen.findByLabelText(/Model, from OpenCode/),
      'opencode/big-pickle',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      /Dreaming will switch off until opencode\/big-pickle is tested/,
    );
  });

  it('refuses a folder with the reason in words and saves a good one', async () => {
    const a = open(viewOf(ready()));
    render(<DreamSetupScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add folder for portal' }),
    );
    const field = screen.getByLabelText('Folder for portal');
    for (const [bad, why] of [
      ['.', /whole repo/],
      ['/etc', /absolute/],
      ['../x', /\.\./],
      ['.opencode/agents', /OpenCode's own configuration/],
      ['a/hooks', /hooks folder/],
    ] as const) {
      await userEvent.clear(field);
      await userEvent.type(field, `${bad}{Enter}`);
      expect(await screen.findByRole('alert')).toHaveTextContent(why);
    }
    expect(callsOf(a.calls, 'dream:save')).toHaveLength(0);
    await userEvent.clear(field);
    await userEvent.type(field, 'AGENTS.md{Enter}');
    await waitFor(() =>
      expect(callsOf(a.calls, 'dream:save')[0][0]).toMatchObject({
        repos: { r1: { on: true, folders: ['.apm', 'AGENTS.md'] } },
      }),
    );
  });

  it('accepts minutes from 1 to 120 only', async () => {
    const a = open(viewOf(ready()));
    render(<DreamSetupScreen />);
    const minutes = await screen.findByLabelText('Minutes idle');
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '121{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(/1 to 120/);
    expect(callsOf(a.calls, 'dream:save')).toHaveLength(0);
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '45{Enter}');
    await waitFor(() =>
      expect(callsOf(a.calls, 'dream:save')[0][0]).toMatchObject({
        idleMinutes: 45,
      }),
    );
  });

  it('follows dream:changed', async () => {
    let current = viewOf(ready({ limit: null }));
    const a = open(current, { 'dream:get': () => current });
    render(<DreamSetupScreen />);
    await screen.findByText(/Not ready to switch on yet/);
    current = viewOf(ready());
    act(() => a.emit('dream:changed', {}));
    expect(
      await screen.findByText(/Dreams run on OpenCode/),
    ).toBeInTheDocument();
  });
});
