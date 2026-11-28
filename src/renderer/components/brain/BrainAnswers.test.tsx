import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainPageRow, BrainSourceRow } from '../../../shared/brain';
import { ASK_CAP_MESSAGE } from '../../../shared/brainAsk';
import type { AskThread } from '../../../shared/brainAsk';
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
  over: Partial<Parameters<typeof BrainAnswers>[0]> = {},
) {
  const a = installFakeApi(handlers);
  useStore.setState({
    brainAsksByTask: { t1: thread },
    brainAskOpenByTask: { t1: true },
    brainAskThread: { t1: { id: 'now', brainId: 'b1', startedAt: 1 } },
    brainAskEarlier: [],
    ...earlierState,
  });
  render(
    <BrainAnswers
      brain={brain}
      owner="t1"
      taskId="t1"
      {...over}
      rows={rows}
      sources={[source]}
      hasAgentTab={hasAgentTab}
      onOpen={onOpen}
      onTerminal={onTerminal}
    />,
  );
  return a;
}

let earlierState: { brainAskEarlier?: AskThread[] } = {};
beforeEach(() => {
  earlierState = {};
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
    expect(screen.getByRole('status').closest('p')).toHaveTextContent(
      /^Answering · /,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(a.calls).toContainEqual({ channel: 'brain:askStop', args: ['t1'] });
  });

  it('keeps what is typed as a follow-up while an answer is coming', async () => {
    const a = show([exchange({ status: 'running', answer: null })]);
    const box = screen.getByRole('textbox', { name: 'Ask a follow-up' });
    await userEvent.type(box, 'And then?{Enter}');
    expect(box).toHaveValue('And then?');
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    expect(
      screen.getByText('Wait for this answer, or stop it'),
    ).toBeInTheDocument();
    expect(a.calls.filter((c) => c.channel === 'brain:ask')).toEqual([]);
  });

  it('shows what the agent reads and the answer as far as it is written', () => {
    show([exchange({ status: 'running', answer: null })]);
    act(() =>
      useStore.getState().setAskProgress('brain:t1', {
        steps: [{ kind: 'read', label: 'Read wiki/a.md' }],
        earlier: 0,
        text: 'Semi',
      }),
    );
    expect(
      screen.getByRole('list', { name: 'What the agent did' }),
    ).toHaveTextContent('Read wiki/a.md');
    expect(screen.getByText('Semi')).toBeInTheDocument();
  });

  it('says how many pages an answer read, with its steps behind their count', () => {
    show([
      exchange({
        answer: {
          sessionId: 's1',
          answer: 'Semicolons.',
          durationMs: 18_400,
          costEur: null,
          changed: false,
          steps: [
            { kind: 'read', label: 'Read wiki/a.md' },
            { kind: 'read', label: 'Read wiki/b.md' },
          ],
          pagesRead: 2,
        },
      }),
    ]);
    expect(
      screen.getByText(
        'Took 18 s · read 2 pages · nothing was changed in the brain',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('2 steps')).toBeInTheDocument();
  });

  it('starts a new question and gets an earlier one back', async () => {
    earlierState = {
      brainAskEarlier: [
        {
          id: 'old',
          brainId: 'b1',
          taskId: 't1',
          startedAt: Date.UTC(2026, 10, 20, 10),
          current: false,
          exchanges: [exchange({ id: 'o1', question: 'Who owns exports?' })],
        },
        {
          id: 'theirs',
          brainId: 'b1',
          taskId: 't2',
          startedAt: 1,
          current: false,
          exchanges: [exchange({ id: 'x1', question: 'Not this task' })],
        },
      ],
    };
    show([exchange({})]);
    const earlier = screen.getByRole('button', {
      name: 'Earlier questions (1)',
    });
    await userEvent.click(earlier);
    expect(screen.queryByText('Not this task')).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: /Who owns exports\?/ }),
    );
    expect(
      screen.getByRole('heading', { name: 'Who owns exports?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Earlier questions (1)' }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'New question' }));
    expect(useStore.getState().brainAsksByTask.t1).toBeUndefined();
    expect(useStore.getState().brainAskEarlier).toHaveLength(3);
    expect(useStore.getState().brainAskOpenByTask.t1).toBe(false);
  });

  it('offers no new question while an answer is coming', () => {
    show([exchange({ status: 'running', answer: null })]);
    expect(screen.getByRole('button', { name: 'New question' })).toBeDisabled();
  });

  it('says when a follow-up began a new conversation', () => {
    show([
      exchange({
        answer: {
          sessionId: 's2',
          answer: 'Open.',
          durationMs: 1000,
          costEur: null,
          changed: false,
          agent: 'claude',
          restarted: true,
        },
      }),
    ]);
    expect(
      screen.getByText(/a new conversation: the brain's agent changed/),
    ).toBeInTheDocument();
  });

  it('only shows a thread that is given to read: nothing can be asked in it', () => {
    show([], {}, true, {
      exchanges: [
        exchange({}),
        exchange({
          id: 'e2',
          question: 'And then?',
          status: 'stopped',
          answer: null,
        }),
      ],
    });
    expect(
      screen.getByRole('heading', { name: 'What was decided?' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New question' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: "Send to this task's agent" }),
    ).toBeNull();
  });

  it('shows a question that is being answered elsewhere without a way to stop it here', () => {
    useStore.getState().setAskProgress('brain:t1', {
      steps: [{ kind: 'read', label: 'Read mine.md' }],
      earlier: 0,
      text: 'My own answer',
    });
    show([], {}, true, {
      exchanges: [exchange({ status: 'running', answer: null })],
    });
    expect(screen.getByText('Being answered in the task.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByText('Read mine.md')).toBeNull();
    expect(screen.queryByText('My own answer')).toBeNull();
  });

  it('shows a stopped question as stopped, and asks it again in its place', async () => {
    const a = show([
      exchange({
        status: 'stopped',
        answer: null,
        startedAt: 1000,
        endedAt: 19_000,
      }),
    ]);
    expect(
      screen.getByText('Stopped after 18 s. Nothing was changed.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:ask',
        args: ['b1', 't1', 'What was decided?', null, 't1', null],
      }),
    );
    expect(useStore.getState().brainAsksByTask.t1).toHaveLength(1);
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
      screen.getByRole('textbox', { name: 'Ask a follow-up' }),
      'Who decides?{Enter}',
    );
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:ask',
        args: ['b1', 't1', 'Who decides?', 's1', 't1', null],
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
        args: ['b1', 't1', 'What was decided?', null, 't1', null],
      }),
    );
    // The new run takes the failed one's place.
    expect(useStore.getState().brainAsksByTask.t1).toHaveLength(1);
  });

  it('leads to Settings when the brain is held', async () => {
    show([
      exchange({
        status: 'failed',
        answer: null,
        error: 'The brain waits for new skills',
        refused: 'held',
      }),
    ]);
    expect(
      screen.queryByRole('button', { name: "Open the brain's terminal" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'Open settings' }),
    );
    expect(useStore.getState().screen).toMatchObject({ kind: 'settings' });
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
    // The button says so, for a moment.
    expect(
      await screen.findByRole('button', { name: 'Copied' }),
    ).toBeInTheDocument();
    await waitFor(
      () =>
        expect(
          screen.getByRole('button', { name: 'Copy' }),
        ).toBeInTheDocument(),
      { timeout: 3000 },
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
