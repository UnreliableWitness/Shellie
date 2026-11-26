import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainPageRow, BrainSourceRow } from '../../../shared/brain';
import { ASK_CAP_MESSAGE } from '../../../shared/brainAsk';
import { type AskExchange, useStore } from '../../store';
import { brainView } from '../../test-helpers/brainFixture';
import { type FakeHandlers, installFakeApi } from '../../test-helpers/fakeApi';
import { BrainAnswers } from './BrainAnswers';

const page = (over: Partial<BrainPageRow>): BrainPageRow => ({
  path: 'wiki/a.md',
  title: 'Exports: formats',
  summary: 'Semicolons.',
  type: 'decision',
  lastUpdated: null,
  confidence: null,
  verified: '2026-11-03',
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
  pictures: [],
  ...over,
});
const source: BrainSourceRow = {
  path: 'sources/d.md',
  type: 'deck',
  ingestedAt: '2026-11-04T10:00:00Z',
  captured: true,
  original: null,
  contents: 'The finance deck',
  note: null,
};
const rows = [
  page({}),
  page({ path: 'wiki/b.md', title: 'Finance review', verified: null }),
];

const exchange = (over: Partial<AskExchange>): AskExchange => ({
  id: 'e1',
  question: 'What was decided?',
  status: 'done',
  startedAt: Date.now(),
  answer: {
    sessionId: 's1',
    answer:
      'Semicolons, see `wiki/b.md` and wiki/a.md.\n\nSources:\n- sources/d.md#slide-4\n- wiki/gone.md',
    durationMs: 18_400,
    costEur: null,
    changed: false,
  },
  error: null,
  refused: null,
  ...over,
});

const onOpen = vi.fn();
const onTerminal = vi.fn();
const brain = brainView({ id: 'b1', name: 'Acme' });

function show(
  thread: AskExchange[],
  handlers: FakeHandlers = {},
  hasAgentTab = true,
) {
  const a = installFakeApi(handlers);
  useStore.setState({
    brainAsksByTask: { t1: thread },
    brainAskOpenByTask: { t1: true },
  });
  render(
    <BrainAnswers
      brain={brain}
      taskId="t1"
      rows={rows}
      sources={[source]}
      hasAgentTab={hasAgentTab}
      onOpen={onOpen}
      onTerminal={onTerminal}
    />,
  );
  return a;
}

beforeEach(() => {
  onOpen.mockReset();
  onTerminal.mockReset();
});
afterEach(cleanup);

describe('BrainAnswers', () => {
  it('shows a running question with a way to stop it', async () => {
    const a = show([exchange({ status: 'running', answer: null })]);
    expect(
      screen.getByRole('heading', { name: 'What was decided?' }),
    ).toBeTruthy();
    expect(screen.getByText(/Reading the brain/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(a.calls).toContainEqual({ channel: 'brain:askStop', args: ['t1'] });
    expect(
      screen.queryByRole('textbox', { name: 'Follow-up question' }),
    ).toBeNull();
  });

  it('renders the answer with links to the pages and sources that exist', async () => {
    show([exchange({})]);
    await userEvent.click(screen.getByRole('link', { name: 'wiki/b.md' }));
    expect(onOpen).toHaveBeenLastCalledWith('wiki/b.md', undefined);
    await userEvent.click(
      screen.getByRole('link', { name: 'sources/d.md#slide-4' }),
    );
    expect(onOpen).toHaveBeenLastCalledWith('sources/d.md', 'slide-4');
    expect(screen.queryByRole('link', { name: 'wiki/gone.md' })).toBeNull();
  });

  it('lists where the answer comes from, in the order named, with who checked it', async () => {
    show([exchange({})]);
    const list = screen.getByRole('list', { name: 'Where this comes from' });
    const cards = [...list.querySelectorAll('button')].map(
      (b) => b.textContent ?? '',
    );
    expect(cards).toHaveLength(3);
    expect(cards[0]).toContain('Finance review');
    expect(cards[0]).toContain('not verified');
    expect(cards[1]).toContain('Exports: formats');
    expect(cards[1]).toContain('verified');
    expect(cards[2]).toContain('The finance deck');
    await userEvent.click(list.querySelectorAll('button')[2]);
    expect(onOpen).toHaveBeenLastCalledWith('sources/d.md', undefined);
  });

  it('leaves the sources out when the answer names none that exist', () => {
    show([
      exchange({
        answer: {
          sessionId: null,
          answer: 'The brain does not answer this. Closest: wiki/gone.md',
          durationMs: 1000,
          costEur: null,
          changed: false,
        },
      }),
    ]);
    expect(screen.getByText(/The brain does not answer this/)).toBeTruthy();
    expect(screen.queryByText('Where this comes from')).toBeNull();
    // Without a session there is nothing to continue in the terminal.
    expect(
      screen.queryByRole('button', { name: 'Continue in the terminal' }),
    ).toBeNull();
  });

  it('says how long it took, what it cost when known, and that nothing changed', () => {
    show([
      exchange({}),
      exchange({
        id: 'e2',
        question: 'And credit notes?',
        answer: {
          sessionId: 's1',
          answer: 'Open.',
          durationMs: 4000,
          costEur: 0.031,
          changed: false,
        },
      }),
    ]);
    const feet = screen.getAllByText(/nothing was changed in the brain/);
    expect(feet[0].textContent).toBe(
      'Took 18 s · nothing was changed in the brain',
    );
    expect(feet[1].textContent).toBe(
      'Took 4 s · €0.03 on the brain · nothing was changed in the brain',
    );
  });

  it("does not claim nothing changed when the brain's folder did", () => {
    show([
      exchange({
        answer: {
          sessionId: 's1',
          answer: 'Open.',
          durationMs: 4000,
          costEur: null,
          changed: true,
        },
      }),
    ]);
    expect(screen.queryByText(/nothing was changed in the brain/)).toBeNull();
    expect(
      screen.getByText(
        /The brain's folder changed while this was answered \(a job or someone at work, most likely\)\. Check the brain's Health\./,
      ),
    ).toBeTruthy();
  });

  it('stacks the exchanges oldest first with the follow-up under the last', async () => {
    const a = show([
      exchange({}),
      exchange({
        id: 'e2',
        question: 'And credit notes?',
        answer: {
          sessionId: 's1',
          answer: 'Open.',
          durationMs: 1,
          costEur: null,
          changed: false,
        },
      }),
    ]);
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent),
    ).toEqual(['What was decided?', 'And credit notes?']);
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Follow-up question' }),
      'Who decides?{Enter}',
    );
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:ask',
        args: ['b1', 't1', 'Who decides?', 's1'],
      }),
    );
  });

  it('shows a failure with a way to try again and the terminal', async () => {
    const def = { id: 'brain-b1', kind: 'claude' as const, label: 'x' };
    const a = show(
      [
        exchange({
          status: 'failed',
          answer: null,
          error: 'Claude Code was not found',
        }),
      ],
      { 'brain:terminal': () => def },
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Claude Code was not found',
    );
    await userEvent.click(
      screen.getByRole('button', { name: "Open the brain's terminal" }),
    );
    await waitFor(() => expect(onTerminal).toHaveBeenCalledWith(def));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:ask',
        args: ['b1', 't1', 'What was decided?', null],
      }),
    );
  });

  it('shows the cap message when the brain reached its limit', () => {
    show([
      exchange({
        status: 'failed',
        answer: null,
        error: ASK_CAP_MESSAGE,
        refused: 'cap',
      }),
    ]);
    expect(screen.getByRole('alert').textContent).toContain(ASK_CAP_MESSAGE);
  });

  it("hands the answer to the task's agent and shows its tab", async () => {
    const a = show([exchange({})], {
      'brain:sendAnswer': () => ({ ok: true, terminalId: 'c1' }),
    });
    await userEvent.click(
      screen.getByRole('button', { name: "Send to this task's agent" }),
    );
    await waitFor(() => expect(useStore.getState().tabByTask.t1).toBe('c1'));
    expect(a.calls).toContainEqual({
      channel: 'brain:sendAnswer',
      args: ['t1', 'What was decided?', exchange({}).answer?.answer],
    });
  });

  it.each([
    ['busy' as const, 'The agent is busy. Try again when it is done.'],
    [
      'typing' as const,
      "The agent's tab has unsent text. Send or clear it first.",
    ],
    ['none' as const, 'No agent tab can take it right now.'],
  ])('says why the agent cannot take it: %s', async (reason, message) => {
    show([exchange({})], {
      'brain:sendAnswer': () => ({ ok: false, reason }),
    });
    await userEvent.click(
      screen.getByRole('button', { name: "Send to this task's agent" }),
    );
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it('offers no send without an agent tab', () => {
    show([exchange({})], {}, false);
    expect(
      screen.queryByRole('button', { name: "Send to this task's agent" }),
    ).toBeNull();
  });

  it('copies the answer as Markdown', async () => {
    const user = userEvent.setup();
    show([exchange({})]);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(
      exchange({}).answer?.answer,
    );
  });

  it('continues the session in the brain terminal', async () => {
    const def = { id: 'brain-b1', kind: 'claude' as const, label: 'x' };
    const a = show([exchange({})], { 'brain:terminal': () => def });
    await userEvent.click(
      screen.getByRole('button', { name: 'Continue in the terminal' }),
    );
    await waitFor(() => expect(onTerminal).toHaveBeenCalledWith(def));
    expect(a.calls).toContainEqual({
      channel: 'brain:terminal',
      args: ['b1', 's1'],
    });
  });

  it("goes back to the brain's start and keeps the thread", async () => {
    show([exchange({})]);
    await userEvent.click(
      screen.getByRole('button', { name: "Back to the brain's start" }),
    );
    expect(useStore.getState().brainAskOpenByTask.t1).toBe(false);
    expect(useStore.getState().brainAsksByTask.t1).toHaveLength(1);
  });
});
