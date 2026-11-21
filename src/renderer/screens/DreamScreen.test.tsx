import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DreamFileDiff,
  DreamProposal,
  DreamResult,
  DreamView,
} from '../../shared/dreams';
import type { TaskView } from '../../shared/types';
import { useStore } from '../store';
import { emptyState, result, viewOf } from '../test-helpers/dreamFixtures';
import { installFakeApi, type FakeHandlers } from '../test-helpers/fakeApi';
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
  it('shows the head: title, meta, kept count and the two actions', async () => {
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
      screen.getByRole('button', { name: 'Open 2 as a task' }),
    ).toBeEnabled();
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
    expect(
      screen.getByRole('button', { name: 'Open 1 as a task' }),
    ).toBeEnabled();
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

  it('disables Open as a task when every proposal is dropped', async () => {
    const r = twoProposals();
    for (const p of r.proposals) p.dropped = true;
    fakeMain(r);
    render(<DreamScreen repoId="r1" />);
    expect(
      await screen.findByRole('button', { name: 'Open 0 as a task' }),
    ).toBeDisabled();
    expect(screen.getByText('0 of 2 kept')).toBeInTheDocument();
  });

  it('opens as a task: New task with the repo, the branch, the dream and its name', async () => {
    const { calls } = fakeMain(twoProposals());
    render(<DreamScreen repoId="r1" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open 2 as a task' }),
    );
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
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open 2 as a task' }),
    );
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
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open 2 as a task' }),
    );
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

// Dreams belong to a project: every test here has one active.
beforeEach(() => {
  activateProject();
});
