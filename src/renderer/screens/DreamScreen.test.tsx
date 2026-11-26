import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DreamAdjustment,
  DreamFileDiff,
  DreamProposal,
  DreamResult,
  DreamView,
} from '../../shared/dreams';
import type { TaskView } from '../../shared/types';
import { allCommands } from '../commands/registry';
import { useStore } from '../store';
import { emptyState, result, viewOf } from '../test-helpers/dreamFixtures';
import { installFakeApi, type FakeHandlers } from '../test-helpers/fakeApi';
import { LEAK_IN_BRANCH } from '../../shared/secrets';
import { DreamScreen } from './DreamScreen';
import { activateProject } from '../test-helpers/project';

// Monaco does not run in jsdom: the full diff is a stand-in that shows what it was given.
vi.mock('../components/review/DiffView', () => ({
  DiffView: (p: { uriKey: string; before: string; after: string }) => (
    <div data-testid="full-diff" data-key={p.uriKey}>
      {`${p.before}|${p.after}`}
    </div>
  ),
}));

const proposal = (
  id: string,
  over: Partial<DreamProposal> = {},
): DreamProposal => ({
  id,
  kind: 'new-rule',
  title: `Title ${id}`,
  why: `Why ${id}`,
  evidence: [],
  files: [],
  commit: 'c'.repeat(40),
  dropped: false,
  ...over,
});

const twoProposals = (over: Partial<DreamResult> = {}): DreamResult =>
  result('2026-11-20-1', 'r1', [], {
    branch: 'dream/2026-11-20-1',
    at: '2026-11-20T03:12:00',
    proposals: [
      proposal('p1', {
        title: 'Migrations are written by hand, never generated',
        why: 'In three tasks the agent generated a migration.',
        evidence: [
          {
            taskId: 't1',
            label: '812 Rounding in invoice totals',
            date: '2026-11-14',
            quote: 'No, we never use the generator here.',
            who: 'you',
          },
          {
            taskId: 'gone',
            label: '820 Archive old statements',
            date: '2026-11-17',
            quote: 'Again a generated migration.',
            who: 'agent',
          },
        ],
      }),
      proposal('p2', {
        kind: 'changed-skill',
        title: 'Skill release-notes: description rewritten',
        why: 'It was never used in 4 tasks that needed it.',
        evidence: [
          {
            taskId: 't1',
            label: '812 Rounding in invoice totals',
            date: '2026-11-19',
            quote: 'Use the release-notes skill.',
            who: 'you',
          },
        ],
      }),
    ],
    ...over,
  });

const line = (
  kind: 'context' | 'add' | 'del' | 'note',
  text: string,
  oldNo: number | null,
  newNo: number | null,
) => ({ kind, text, oldNo, newNo });

const diffs: Record<string, DreamFileDiff[]> = {
  p1: [
    {
      path: '.apm/instructions/database.instructions.md',
      added: 2,
      removed: 1,
      hunks: [
        {
          header: '@@ -1,3 +1,4 @@',
          lines: [
            line('context', '## Schema', 1, 1),
            line('del', '- old line', 2, null),
            line('add', '- new line', null, 2),
            line('context', '- keep', 3, 3),
            line('add', '- more', null, 4),
          ],
        },
      ],
    },
  ],
  p2: [
    {
      path: '.apm/skills/release-notes/SKILL.md',
      added: 400,
      removed: 0,
      truncated: true,
      hunks: [
        {
          header: '@@ -0,0 +1,450 @@',
          lines: Array.from({ length: 400 }, (_, i) =>
            line('add', `line ${i}`, null, i + 1),
          ),
        },
      ],
    },
    {
      path: '.apm/skills/release-notes/logo.png',
      added: 0,
      removed: 0,
      hunks: [],
      binary: true,
    },
  ],
};

/** A fake main that holds the view: drop changes it and sends `dream:changed`, as main does. */
function fakeMain(r: DreamResult | null, extra: FakeHandlers = {}) {
  let view: DreamView = withResult(r);
  function withResult(res: DreamResult | null): DreamView {
    const v = viewOf();
    v.repos[0].state = emptyState({ result: res });
    return v;
  }
  const api = installFakeApi({
    'dream:get': () => view,
    'dream:diff': (_repoId, id) => diffs[id] ?? [],
    'dream:file': () => ({
      before: '## Schema\n- old line\n- keep\n',
      after: '## Schema\n- new line\n- keep\n- more\n',
    }),
    'dream:drop': (_repoId, id, dropped) => {
      const res = view.repos[0].state.result!;
      view = withResult({
        ...res,
        proposals: res.proposals.map((p) =>
          p.id === id ? { ...p, dropped } : p,
        ),
      });
      api.emit('dream:changed', {});
    },
    ...extra,
  });
  return {
    ...api,
    set(res: DreamResult | null) {
      view = withResult(res);
      api.emit('dream:changed', {});
    },
  };
}

const openCommand = () =>
  allCommands().find((c) => c.id === 'dream.openAsTask');

const callsOf = (
  calls: { channel: string; args: unknown[] }[],
  channel: string,
) => calls.filter((c) => c.channel === channel).map((c) => c.args);

const list = () => screen.getByRole('list', { name: 'Proposals' });
const rowButton = (title: string) =>
  within(list()).getByRole('button', { name: new RegExp(title) });
const detail = () =>
  screen.getByRole('region', { name: /^(Title|Migrations|Skill)/ });

beforeEach(() => {
  useStore.setState({
    screen: { kind: 'dream', repoId: 'r1' },
    previous: null,
    notices: [],
    tasks: [
      {
        id: 't1',
        status: 'ready',
        repoId: 'r1',
        name: 'Rounding',
        worktreePath: '/src/portal.worktrees/rounding',
      } as TaskView,
    ],
  });
});

describe('DreamScreen', () => {
  it('has a way back to Dreams in its head, now that no breadcrumb leads there', async () => {
    fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Dreams' }),
    );
    expect(useStore.getState().screen).toEqual({ kind: 'dreams' });
  });

  it('shows the head: title, meta and kept count, without Change with an agent', async () => {
    fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'What portal’s sessions taught',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/from 6 sessions/)).toBeInTheDocument();
    expect(screen.getByText('zai/glm-5.3')).toBeInTheDocument();
    expect(screen.getByText('790 000 tokens')).toBeInTheDocument();
    expect(screen.getByText('dream/2026-11-20-1')).toBeInTheDocument();
    expect(screen.getByText('2 of 2 kept')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Change with an agent' }),
    ).toBeNull();
  });

  it('chooses the first proposal that is not dropped on open', async () => {
    const r = twoProposals();
    r.proposals[0].dropped = true;
    fakeMain(r);
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    expect(rowButton('Skill release-notes')).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(rowButton('Migrations')).not.toHaveAttribute('aria-current');
    expect(detail()).toHaveAccessibleName(
      'Skill release-notes: description rewritten',
    );
  });

  it('shows the chosen proposal with its evidence and files, and another one when chosen', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    const first = await screen.findByRole('region', { name: /^Migrations/ });
    expect(within(first).getByText('New rule')).toBeInTheDocument();
    expect(
      within(first).getByText(
        'In three tasks the agent generated a migration.',
      ),
    ).toBeInTheDocument();
    // The screen adds the quotation marks.
    expect(
      within(first).getByText('“No, we never use the generator here.”'),
    ).toBeInTheDocument();
    expect(
      await within(first).findByText(
        '.apm/instructions/database.instructions.md',
      ),
    ).toBeInTheDocument();
    expect(within(first).getByText('+2')).toBeInTheDocument();
    expect(within(first).getByText('−1')).toBeInTheDocument();
    expect(within(first).getByText('- new line')).toBeInTheDocument();
    expect(within(first).getByText('- old line')).toBeInTheDocument();
    // As many added and removed lines shown as the counts beside them say.
    const file = within(first).getByRole('group', {
      name: '.apm/instructions/database.instructions.md',
    });
    expect(file.querySelectorAll('.dream-line.is-add')).toHaveLength(2);
    expect(file.querySelectorAll('.dream-line.is-del')).toHaveLength(1);

    await userEvent.click(rowButton('Skill release-notes'));
    const second = screen.getByRole('region', { name: /^Skill/ });
    expect(within(second).getByText('Changed skill')).toBeInTheDocument();
    expect(
      within(second).getByText('“Use the release-notes skill.”'),
    ).toBeInTheDocument();
    expect(
      await within(second).findByText('.apm/skills/release-notes/SKILL.md'),
    ).toBeInTheDocument();
    expect(
      within(second).getByText('Binary file: no lines to show.'),
    ).toBeInTheDocument();
    expect(
      within(second).getByText(
        'Showing the first 400 lines of this change. Open in full diff for the rest.',
      ),
    ).toBeInTheDocument();
    expect(callsOf(calls, 'dream:diff')).toEqual([
      ['r1', 'p1'],
      ['r1', 'p2'],
    ]);
  });

  it('shows the kind and the tasks seen in each row', async () => {
    fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    expect(rowButton('Migrations')).toHaveTextContent(
      'New rule · seen in 2 tasks',
    );
    expect(rowButton('Skill release-notes')).toHaveTextContent(
      'Changed skill · seen in 1 task',
    );
  });

  it('says who said each quote, and shows quotes nobody was found to say last', async () => {
    const r = twoProposals();
    r.proposals[0].evidence = [
      {
        taskId: 'gone',
        label: '820 Archive old statements',
        date: '2026-11-17',
        quote: 'Words not in the sessions.',
        who: 'unknown',
      },
      {
        taskId: 't1',
        label: '812 Rounding in invoice totals',
        date: '2026-11-14',
        quote: 'No, we never use the generator here.',
        who: 'you',
      },
      {
        taskId: 'gone',
        label: '820 Archive old statements',
        date: '2026-11-17',
        quote: 'I generated the migration.',
        who: 'agent',
      },
    ];
    fakeMain(r);
    const { container } = render(<DreamScreen repoId="r1" />);
    await screen.findByRole('region', { name: 'Where it comes from' });
    const captions = [...container.querySelectorAll('.dream-quote')].map(
      (f) => [
        f.querySelector('blockquote')!.textContent,
        f.querySelector('figcaption')!.textContent,
      ],
    );
    expect(captions).toEqual([
      [
        '“No, we never use the generator here.”',
        'You, in812 Rounding in invoice totals14 Nov',
      ],
      [
        '“I generated the migration.”',
        'The agent, in820 Archive old statements17 Nov',
      ],
      ['“Words not in the sessions.”', 'From820 Archive old statements17 Nov'],
    ]);
  });

  it('links evidence to a task in the store and leaves a missing one plain', async () => {
    fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    const ev = await screen.findByRole('region', {
      name: 'Where it comes from',
    });
    expect(
      within(ev).queryByRole('button', { name: '820 Archive old statements' }),
    ).toBeNull();
    expect(
      within(ev).getByText('820 Archive old statements'),
    ).toBeInTheDocument();
    expect(within(ev).getByText('17 Nov')).toBeInTheDocument();
    await userEvent.click(
      within(ev).getByRole('button', {
        name: '812 Rounding in invoice totals',
      }),
    );
    expect(useStore.getState().selectedTaskId).toBe('t1');
    expect(useStore.getState().screen).toEqual({ kind: 'task' });
  });

  it('Drop calls dream:drop and the head and row follow the view; Undo takes it back', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    const drop = await screen.findByRole('button', {
      name: 'Drop this proposal',
    });
    await userEvent.click(drop);
    expect(callsOf(calls, 'dream:drop')).toEqual([['r1', 'p1', true]]);
    expect(await screen.findByText('1 of 2 kept')).toBeInTheDocument();
    expect(rowButton('Migrations')).toHaveTextContent('Dropped');
    const undo = within(list()).getByRole('button', { name: /^Undo/ });
    await userEvent.click(undo);
    expect(callsOf(calls, 'dream:drop')).toEqual([
      ['r1', 'p1', true],
      ['r1', 'p1', false],
    ]);
    expect(await screen.findByText('2 of 2 kept')).toBeInTheDocument();
  });

  it('keeps Drop disabled until the new view has arrived', async () => {
    let release = () => {};
    const m = fakeMain(twoProposals(), {
      'dream:drop': () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    render(<DreamScreen repoId="r1" />);
    const drop = await screen.findByRole('button', {
      name: 'Drop this proposal',
    });
    await userEvent.click(drop);
    expect(drop).toBeDisabled();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(drop).toBeDisabled();
    const r = twoProposals();
    r.proposals[0].dropped = true;
    m.set(r);
    const detail = screen.getByRole('region', { name: /^Migrations/ });
    await waitFor(() =>
      expect(
        within(detail).getByRole('button', { name: 'Undo' }),
      ).toBeEnabled(),
    );
  });

  it('enables Drop again when the call fails, and says why', async () => {
    fakeMain(twoProposals(), {
      'dream:drop': () => {
        throw new Error('The dream could not be saved');
      },
    });
    render(<DreamScreen repoId="r1" />);
    const drop = await screen.findByRole('button', {
      name: 'Drop this proposal',
    });
    await userEvent.click(drop);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The dream could not be saved',
    );
    expect(drop).toBeEnabled();
  });

  it('does not offer Open this dream as a task when every proposal is dropped', async () => {
    const r = twoProposals();
    for (const p of r.proposals) p.dropped = true;
    fakeMain(r);
    render(<DreamScreen repoId="r1" />);
    expect(await screen.findByText('0 of 2 kept')).toBeInTheDocument();
    expect(openCommand()).toBeUndefined();
  });

  it('opens as a task from the palette: New task with the repo, the branch, the dream and its name', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    expect(openCommand()).toMatchObject({
      title: 'Open this dream as a task',
      group: 'tasks',
    });
    act(() => openCommand()!.run());
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'new-task',
        repoId: 'r1',
        dream: {
          id: '2026-11-20-1',
          branch: 'dream/2026-11-20-1',
          name: 'Dream 20 Nov',
        },
      }),
    );
    expect(callsOf(calls, 'dream:openAsTask')).toEqual([['r1']]);
  });

  it('names the task Dream <date> 2 when the repo has a task of that name', async () => {
    useStore.setState({
      tasks: [
        {
          id: 't9',
          status: 'ready',
          repoId: 'r1',
          name: 'Dream 20 Nov',
          worktreePath: '/src/portal.worktrees/dream-20-nov',
        } as TaskView,
      ],
    });
    fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    act(() => openCommand()!.run());
    await waitFor(() =>
      expect(useStore.getState().screen).toMatchObject({
        kind: 'new-task',
        dream: { name: 'Dream 20 Nov 2' },
      }),
    );
  });

  it('shows a refused Open as a task in its phrase and stays', async () => {
    fakeMain(twoProposals(), {
      'dream:openAsTask': () => {
        throw new Error('The dream could not be opened as a task');
      },
    });
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    act(() => openCommand()!.run());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The dream could not be opened as a task',
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'dream',
      repoId: 'r1',
    });
  });

  it('asks before Discard, then discards and returns to Dreams', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Discard dream' }),
    );
    expect(callsOf(calls, 'dream:discard')).toEqual([]);
    const ask = screen.getByRole('alertdialog');
    expect(ask).toHaveTextContent(
      'Discard this dream? Its branch and proposals are removed. The ideas are remembered so they are not proposed again without new evidence.',
    );
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(callsOf(calls, 'dream:discard')).toEqual([]);
    await userEvent.click(
      screen.getByRole('button', { name: 'Discard dream' }),
    );
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Discard',
      }),
    );
    expect(callsOf(calls, 'dream:discard')).toEqual([['r1']]);
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'dreams' }),
    );
  });

  it('names the reverted paths only when there are some', async () => {
    const m = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    expect(
      screen.queryByText(/Changes outside the allowed folders/),
    ).toBeNull();
    m.set(twoProposals({ reverted: ['src/app.ts', 'package.json'] }));
    expect(
      await screen.findByText(
        'Changes outside the allowed folders were removed: src/app.ts, package.json',
      ),
    ).toBeInTheDocument();
  });

  it('says how many ideas the check removed', async () => {
    fakeMain(twoProposals({ removedByCheck: 1 }));
    render(<DreamScreen repoId="r1" />);
    expect(
      await screen.findByText(
        "One more idea did not survive the dream's own check. It is remembered in case it comes up again.",
      ),
    ).toBeInTheDocument();
  });

  it('opens a file in the full diff with both texts', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^Open in full diff/ }),
    );
    expect((await screen.findByTestId('full-diff')).textContent).toBe(
      '## Schema\n- old line\n- keep\n|## Schema\n- new line\n- keep\n- more\n',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Back to the changes' }),
    );
    expect(screen.queryByTestId('full-diff')).toBeNull();
    expect(callsOf(calls, 'dream:file')).toEqual([
      ['r1', 'p1', '.apm/instructions/database.instructions.md'],
    ]);
  });

  it('says when the full diff has no text to show', async () => {
    fakeMain(twoProposals(), { 'dream:file': () => ({ tooLarge: true }) });
    render(<DreamScreen repoId="r1" />);
    await userEvent.click(
      await screen.findByRole('button', { name: /^Open in full diff/ }),
    );
    expect(
      await screen.findByText('Too large to show here.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('full-diff')).toBeNull();
  });

  it('fetches a proposal’s changes once, also after Drop and choosing it again', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Drop this proposal' }),
    );
    expect(await screen.findByText('1 of 2 kept')).toBeInTheDocument();
    await userEvent.click(rowButton('Skill release-notes'));
    await userEvent.click(rowButton('Migrations'));
    await screen.findByText('- old line');
    expect(callsOf(calls, 'dream:diff')).toEqual([
      ['r1', 'p1'],
      ['r1', 'p2'],
    ]);
  });

  it('moves between proposals with Up and Down', async () => {
    fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    rowButton('Migrations').focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(rowButton('Skill release-notes')).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(rowButton('Skill release-notes')).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(rowButton('Migrations')).toHaveAttribute('aria-current', 'true');
  });

  it('leaves Up and Down alone on an Undo button', async () => {
    const r = twoProposals();
    r.proposals[0].dropped = true;
    fakeMain(r);
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    within(list()).getByRole('button', { name: /^Undo/ }).focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(rowButton('Skill release-notes')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('shows text from the dream as plain text', async () => {
    fakeMain(
      twoProposals({
        proposals: [proposal('p1', { title: '<b>bold</b> **x**' })],
      }),
    );
    render(<DreamScreen repoId="r1" />);
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: '<b>bold</b> **x**',
      }),
    ).toBeInTheDocument();
  });

  it('goes back to Dreams when the repo has no open result', async () => {
    const m = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    m.set(null);
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'dreams' }),
    );
  });

  it('shows the loading state, and a failed load with Try again', async () => {
    let fail = true;
    installFakeApi({
      'dream:get': () => {
        if (fail) throw new Error('no');
        const v = viewOf();
        v.repos[0].state = emptyState({ result: twoProposals() });
        return v;
      },
    });
    render(<DreamScreen repoId="r1" />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(
      await screen.findByText('The dream could not be loaded'),
    ).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('list', { name: 'Proposals' }),
    ).toBeInTheDocument();
  });
});

describe('DreamScreen: what to do with a dream', () => {
  const notices = () => useStore.getState().notices.map((n) => n.message);
  const prCalls = (calls: { channel: string; args: unknown[] }[]) =>
    callsOf(calls, 'dream:pr');

  it('says what a dream is and what to do, and creates the pull request', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    expect(
      await screen.findByText(
        /Shellie proposes these changes to this repo’s skills and rules, from your past sessions\. Drop what you don’t want, ask for a change where one is nearly right, then create a pull request\./,
      ),
    ).toBeInTheDocument();
    const create = await screen.findByRole('button', {
      name: 'Create pull request',
    });
    await waitFor(() => expect(create).toBeEnabled());
    expect(create).toHaveClass('btn-primary');
    await userEvent.click(create);
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'dreams' }),
    );
    expect(prCalls(calls)).toEqual([['r1', false]]);
    expect(notices()).toContain('Pull request !7 created from the dream');
  });

  it('offers Push branch, with the reason, where Shellie can make no pull request', async () => {
    const { calls } = fakeMain(twoProposals(), {
      'dream:prTarget': () => ({
        available: false,
        reason: 'origin is not an Azure Repos URL',
      }),
      'dream:pr': () => ({ kind: 'pushed', branch: 'dream/2026-11-20-1' }),
    });
    render(<DreamScreen repoId="r1" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Push branch' }),
    );
    expect(
      screen.getByText(
        'Shellie cannot make a pull request here: origin is not an Azure Repos URL. It pushes the branch instead.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create pull request' }),
    ).toBeNull();
    await waitFor(() =>
      expect(notices()).toContain('Branch dream/2026-11-20-1 pushed'),
    );
    expect(prCalls(calls)).toEqual([['r1', false]]);
  });

  it('asks before pushing a stored secret, and pushes only after Push anyway', async () => {
    let anyway = false;
    const { calls } = fakeMain(twoProposals(), {
      'dream:pr': (_repoId, pushAnyway) => {
        if (!pushAnyway) throw new Error(`${LEAK_IN_BRANCH}; not pushed`);
        anyway = true;
        return { kind: 'pr', id: 7, url: 'https://example.invalid/pr/7' };
      },
    });
    render(<DreamScreen repoId="r1" />);
    const create = await screen.findByRole('button', {
      name: 'Create pull request',
    });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    expect(
      await screen.findByText(`${LEAK_IN_BRANCH}. Push anyway?`),
    ).toBeInTheDocument();
    expect(useStore.getState().screen).toEqual({ kind: 'dream', repoId: 'r1' });
    expect(anyway).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Push anyway' }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'dreams' }),
    );
    expect(prCalls(calls)).toEqual([
      ['r1', false],
      ['r1', true],
    ]);
  });

  it('takes the secret prompt away when the kept proposals change: the check is asked again', async () => {
    const { calls } = fakeMain(twoProposals(), {
      'dream:pr': () => {
        throw new Error(`${LEAK_IN_BRANCH}; not pushed`);
      },
    });
    render(<DreamScreen repoId="r1" />);
    const create = await screen.findByRole('button', {
      name: 'Create pull request',
    });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    await screen.findByRole('button', { name: 'Push anyway' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Drop this proposal' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Push anyway' })).toBeNull(),
    );
    expect(prCalls(calls)).toEqual([['r1', false]]);
  });

  it('shows a failed pull request in its phrase, stays, and can be pressed again', async () => {
    let fail = true;
    fakeMain(twoProposals(), {
      'dream:pr': () => {
        if (fail) throw new Error('Could not create the pull request');
        return { kind: 'pr', id: 7, url: 'https://example.invalid/pr/7' };
      },
    });
    render(<DreamScreen repoId="r1" />);
    const create = await screen.findByRole('button', {
      name: 'Create pull request',
    });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not create the pull request',
    );
    expect(useStore.getState().screen).toEqual({ kind: 'dream', repoId: 'r1' });
    fail = false;
    await userEvent.click(create);
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({ kind: 'dreams' }),
    );
  });

  it('disables Create pull request when every proposal is dropped', async () => {
    fakeMain(twoProposals({ proposals: [proposal('p1', { dropped: true })] }));
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('button', { name: 'Discard dream' });
    await new Promise((r) => setTimeout(r, 20));
    expect(
      screen.getByRole('button', { name: 'Create pull request' }),
    ).toBeDisabled();
  });
});

describe('DreamScreen: asking for a change', () => {
  const box = () =>
    screen.getByRole('textbox', { name: 'Ask for a change to this proposal' });
  const foot = () => screen.getByRole('group', { name: 'Ask for a change' });
  const adjustment = (
    ask: string,
    note: string,
    over: Partial<DreamAdjustment> = {},
  ): DreamAdjustment => ({
    ask,
    at: '2026-11-26T10:00:00',
    note,
    changed: true,
    reverted: [],
    before: { commit: 'b'.repeat(40), files: [], title: 'Old', why: 'Old' },
    ...over,
  });
  const withP1 = (
    over: Partial<DreamProposal>,
    res: Partial<DreamResult> = {},
  ) => {
    const r = twoProposals(res);
    r.proposals[0] = { ...r.proposals[0], ...over };
    return r;
  };
  /** Selects an element's text as a drag would, and lets the page hear of it before anything else happens. */
  const selectText = async (el: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await new Promise((r) => setTimeout(r, 0));
  };
  const running = (proposalId: string, ask = 'make it shorter') => ({
    adjusting: { proposalId, ask, startedAt: 1 },
  });

  it('sends the trimmed ask with Enter, and empties the box', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    expect(box()).toHaveAttribute(
      'placeholder',
      'Ask for a change to this proposal',
    );
    await userEvent.type(box(), '  make it shorter  {Enter}');
    expect(callsOf(calls, 'dream:adjust')).toEqual([
      ['r1', 'p1', 'make it shorter'],
    ]);
    await waitFor(() => expect(box()).toHaveValue(''));
  });

  it('makes a new line with Shift+Enter, and sends with the Ask button', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    await userEvent.type(box(), 'one{Shift>}{Enter}{/Shift}two');
    expect(callsOf(calls, 'dream:adjust')).toEqual([]);
    expect(box()).toHaveValue('one\ntwo');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(callsOf(calls, 'dream:adjust')).toEqual([['r1', 'p1', 'one\ntwo']]);
  });

  it('cannot send an empty ask', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    await userEvent.type(box(), '   {Enter}');
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    expect(callsOf(calls, 'dream:adjust')).toEqual([]);
  });

  it('sends the text selected in the pane as the quote; Escape and the chip’s button remove it', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    const why = await screen.findByText(
      'In three tasks the agent generated a migration.',
    );
    const select = () => selectText(why);
    const chip = 'About: “In three tasks the agent generated a migration.”';
    await select();
    act(() => box().focus());
    expect(screen.getByText(chip)).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText(chip)).toBeNull();

    act(() => box().blur());
    await select();
    act(() => box().focus());
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Remove the selected text from the ask',
      }),
    );
    expect(screen.queryByText(chip)).toBeNull();
    expect(box()).toHaveFocus();

    act(() => box().blur());
    await select();
    act(() => box().focus());
    window.getSelection()!.removeAllRanges();
    await userEvent.type(box(), 'say why{Enter}');
    expect(callsOf(calls, 'dream:adjust')).toEqual([
      [
        'r1',
        'p1',
        'say why',
        'In three tasks the agent generated a migration.',
      ],
    ]);
    await waitFor(() => expect(screen.queryByText(chip)).toBeNull());
  });

  it('cuts a long quote, and takes no quote from outside the pane', async () => {
    const long = 'x'.repeat(700);
    fakeMain(withP1({ why: long }));
    render(<DreamScreen repoId="r1" />);
    await selectText(await screen.findByText(long));
    act(() => box().focus());
    expect(screen.getByText(`About: “${'x'.repeat(600)}”`)).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    act(() => box().blur());
    await selectText(screen.getByText('dream/2026-11-20-1'));
    act(() => box().focus());
    expect(screen.queryByText(/^About:/)).toBeNull();
    window.getSelection()!.removeAllRanges();
  });

  it('keeps the ask and says why when main refuses it', async () => {
    fakeMain(twoProposals(), {
      'dream:adjust': () => {
        throw new Error('A change is already being made');
      },
    });
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    await userEvent.type(box(), 'make it shorter{Enter}');
    expect(await within(foot()).findByRole('alert')).toHaveTextContent(
      'A change is already being made',
    );
    expect(box()).toHaveValue('make it shorter');
  });

  it('keeps what was typed while another proposal is read', async () => {
    fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    await userEvent.type(box(), 'half an ask');
    await userEvent.click(rowButton('Skill release-notes'));
    expect(box()).toHaveValue('');
    await userEvent.click(rowButton('Migrations'));
    expect(box()).toHaveValue('half an ask');
  });

  it('shows the run under way: Working on, Stop, the other boxes and Create pull request off', async () => {
    const { calls } = fakeMain(twoProposals(running('p1')));
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    expect(
      within(foot()).getByText('Working on: “make it shorter”'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', {
        name: 'Ask for a change to this proposal',
      }),
    ).toBeNull();
    expect(
      within(rowButton('Migrations')).getByRole('img', {
        name: 'A change is being made',
      }),
    ).toBeInTheDocument();
    expect(within(rowButton('Skill release-notes')).queryByRole('img')).toBe(
      null,
    );
    const sentence =
      'A change to “Migrations are written by hand, never generated” is being made';
    const create = screen.getByRole('button', { name: 'Create pull request' });
    await new Promise((r) => setTimeout(r, 20));
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', sentence);
    expect(
      screen.getByRole('button', { name: 'Drop this proposal' }),
    ).toBeDisabled();
    expect(openCommand()).toBeUndefined();

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(callsOf(calls, 'dream:adjustStop')).toEqual([['r1']]);

    await userEvent.click(rowButton('Skill release-notes'));
    expect(box()).toBeDisabled();
    expect(box()).toHaveAccessibleDescription(sentence);
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    expect(within(foot()).getByText(sentence)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('says what the ask came to and puts the focus back in the box when the run ends', async () => {
    const m = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    await userEvent.type(box(), 'make it shorter{Enter}');
    m.set(twoProposals(running('p1')));
    const working = await screen.findByText('Working on: “make it shorter”');
    expect(working).toHaveFocus();
    expect(within(foot()).getByRole('status')).toHaveTextContent('');

    m.set(
      withP1({
        title: 'Migrations are written by hand',
        commit: 'd'.repeat(40),
        adjustments: [adjustment('make it shorter', 'Cut the second example.')],
      }),
    );
    await waitFor(() =>
      expect(within(foot()).getByRole('status')).toHaveTextContent(
        'Changed: Cut the second example.',
      ),
    );
    expect(box()).toHaveFocus();
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Migrations are written by hand',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create pull request' }),
    ).toBeEnabled();
  });

  it('shows the asks as asked and answered, with Undo on the newest that changed something', async () => {
    const { calls } = fakeMain(
      withP1({
        adjustments: [
          adjustment('make it shorter', 'Cut the second example.', {
            quote: 'the second example',
            reverted: ['src/app.ts', 'package.json'],
          }),
          adjustment('why this folder?', 'It is where the rules live.', {
            changed: false,
            before: undefined,
          }),
        ],
      }),
    );
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    const asks = within(foot())
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(asks).toEqual([
      'You: make it shorterAbout: “the second example”Changed: Cut the second example.UndoLeft as they were: src/app.ts, package.json',
      'You: why this folder?Answer: It is where the rules live.',
    ]);
    expect(screen.queryByRole('button', { name: /^Earlier asks/ })).toBeNull();
    expect(rowButton('Migrations')).toHaveTextContent(
      'New rule · seen in 2 tasks · changed',
    );
    expect(rowButton('Skill release-notes')).not.toHaveTextContent('changed');

    await userEvent.click(within(foot()).getByRole('button', { name: 'Undo' }));
    expect(callsOf(calls, 'dream:adjustUndo')).toEqual([['r1', 'p1']]);
    await waitFor(() => expect(box()).toHaveFocus());
    expect(within(foot()).getByRole('status')).toHaveTextContent(
      'The change was taken back',
    );
  });

  it('has no Undo when no ask changed the proposal, and none is pressed while a run is under way', async () => {
    const answer = adjustment('why?', 'Because.', {
      changed: false,
      before: undefined,
    });
    const m = fakeMain(withP1({ adjustments: [answer] }));
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    expect(within(foot()).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(rowButton('Migrations')).not.toHaveTextContent('changed');
    m.set(
      withP1(
        { adjustments: [adjustment('shorter', 'Done.'), answer] },
        running('p2'),
      ),
    );
    expect(
      await within(foot()).findByRole('button', { name: 'Undo' }),
    ).toBeDisabled();
  });

  it('shows the last three asks, and the rest behind Earlier asks (n)', async () => {
    fakeMain(
      withP1({
        adjustments: [1, 2, 3, 4, 5].map((n) =>
          adjustment(`ask ${n}`, `note ${n}`, {
            at: `2026-11-26T10:0${n}:00`,
          }),
        ),
      }),
    );
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    const shown = () =>
      within(foot())
        .getAllByRole('listitem')
        .map((li) => li.querySelector('p')!.textContent);
    expect(shown()).toEqual(['You: ask 3', 'You: ask 4', 'You: ask 5']);
    // Only the newest change can be taken back.
    expect(
      within(foot()).getAllByRole('button', { name: 'Undo' }),
    ).toHaveLength(1);
    const earlier = screen.getByRole('button', { name: 'Earlier asks (2)' });
    expect(earlier).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(earlier);
    expect(earlier).toHaveAttribute('aria-expanded', 'true');
    expect(shown()).toEqual([
      'You: ask 1',
      'You: ask 2',
      'You: ask 3',
      'You: ask 4',
      'You: ask 5',
    ]);
  });

  it('shows a failed ask with its phrase; Try again puts the ask and its quote back', async () => {
    fakeMain(
      twoProposals({
        adjustFailed: {
          proposalId: 'p1',
          ask: 'make it shorter',
          quote: 'the second example',
          reason: 'The agent changed nothing',
        },
      }),
    );
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    expect(
      within(foot()).getByText(
        'Could not make the change: The agent changed nothing',
      ),
    ).toBeInTheDocument();
    expect(box()).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(box()).toHaveValue('make it shorter');
    expect(box()).toHaveFocus();
    expect(screen.getByText('About: “the second example”')).toBeInTheDocument();

    // The failure is the other proposal's: nothing about it here.
    await userEvent.click(rowButton('Skill release-notes'));
    expect(screen.queryByText(/Could not make the change/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('says a run that failed when it ends', async () => {
    const m = fakeMain(twoProposals(running('p1')));
    render(<DreamScreen repoId="r1" />);
    await screen.findByText('Working on: “make it shorter”');
    m.set(
      twoProposals({
        adjustFailed: {
          proposalId: 'p1',
          ask: 'make it shorter',
          reason: 'Stopped',
        },
      }),
    );
    await waitFor(() =>
      expect(within(foot()).getByRole('status')).toHaveTextContent(
        'Could not make the change: Stopped',
      ),
    );
    expect(box()).toHaveFocus();
  });

  it('switches the box off for a dropped proposal', async () => {
    fakeMain(withP1({ dropped: true }));
    render(<DreamScreen repoId="r1" />);
    await screen.findByRole('list', { name: 'Proposals' });
    await userEvent.click(rowButton('Migrations'));
    expect(box()).toBeDisabled();
    expect(box()).toHaveAccessibleDescription(
      'Take the proposal back to change it',
    );
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
  });

  it('fetches the changes again when an ask gave the chosen proposal a new commit, and shows the last ones meanwhile', async () => {
    let release = () => {};
    let late = false;
    const m = fakeMain(twoProposals(), {
      'dream:diff': (_repoId, id) =>
        late
          ? new Promise<DreamFileDiff[]>((resolve) => {
              release = () =>
                resolve([{ ...diffs.p1[0], path: '.apm/new.md' }]);
            })
          : (diffs[id] ?? []),
    });
    render(<DreamScreen repoId="r1" />);
    await screen.findByText('- old line');
    late = true;
    m.set(
      withP1({
        commit: 'd'.repeat(40),
        adjustments: [adjustment('rename it', 'Renamed.')],
      }),
    );
    await waitFor(() =>
      expect(callsOf(m.calls, 'dream:diff')).toEqual([
        ['r1', 'p1'],
        ['r1', 'p1'],
      ]),
    );
    expect(
      screen.getByText('.apm/instructions/database.instructions.md'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Loading the changes/)).toBeNull();
    await act(async () => release());
    expect(await screen.findByText('.apm/new.md')).toBeInTheDocument();
    expect(
      screen.queryByText('.apm/instructions/database.instructions.md'),
    ).toBeNull();
  });
});

// Dreams belong to a project: every test here has one active.
beforeEach(() => {
  activateProject();
});
