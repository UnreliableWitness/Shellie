import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainPageRow } from '../../../shared/brain';
import { ASK_SUGGESTIONS } from '../../../shared/brainAsk';
import type { TaskView } from '../../../shared/types';
import { useStore } from '../../store';
import { brainView } from '../../test-helpers/brainFixture';
import { type FakeHandlers, installFakeApi } from '../../test-helpers/fakeApi';
import { BrainTab } from './BrainTab';

const page = (path: string, title: string): BrainPageRow => ({
  path,
  title,
  summary: `${title} in short.`,
  type: 'other',
  lastUpdated: null,
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
  pictures: [],
});
const pages = [
  page('wiki/scope.md', 'Scope of work'),
  page('wiki/account.md', 'Account'),
];
const task = (over: Partial<TaskView> = {}) =>
  ({
    id: 't1',
    name: 'invoice-export',
    workItem: {
      id: '412',
      type: 'Task',
      title: 'Export invoices as CSV',
      url: null,
      project: 'Shellie',
    },
    terminals: [],
    ...over,
  }) as unknown as TaskView;

const onTerminal = vi.fn();
const brain = brainView({ id: 'b1', name: 'Acme' });

function show(handlers: FakeHandlers = {}, t: TaskView = task()) {
  const a = installFakeApi({
    'brain:pages': () => pages,
    'brain:relevant': () => ['wiki/scope.md'],
    ...handlers,
  });
  useStore.setState({
    tasks: [t],
    brainAsksByTask: {},
    brainAskOpenByTask: {},
    reading: [],
  });
  render(
    <BrainTab brain={brain} taskId="t1" hasAgentTab onTerminal={onTerminal} />,
  );
  return a;
}

beforeEach(() => onTerminal.mockReset());
afterEach(cleanup);

describe('BrainTab', () => {
  it('says what the brain is and names the work item', async () => {
    show();
    expect(
      screen.getByRole('heading', {
        name: 'What the project already knows about this task',
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /The brain keeps the project's decisions, documents and meeting notes as pages\. Ask it, read what applies to/,
      ).textContent,
    ).toBe(
      "The brain keeps the project's decisions, documents and meeting notes as pages. Ask it, read what applies to Export invoices as CSV, and add what you learn.",
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Open the whole brain' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'brain',
      brainId: 'b1',
    });
  });

  it('names the task when it has no work item', () => {
    show({}, task({ workItem: null }));
    expect(
      screen.getByText(/The brain keeps the project's decisions/).textContent,
    ).toContain('read what applies to invoice-export, and add');
  });

  it('starts no agent by being opened', async () => {
    const a = show();
    await screen.findByRole('button', { name: /Scope of work/ });
    expect(
      a.calls.filter(
        (c) => c.channel === 'brain:ask' || c.channel === 'brain:terminal',
      ),
    ).toEqual([]);
  });

  it('asks a typed question and shows the answers', async () => {
    const a = show({
      'brain:ask': () => ({
        ok: true,
        answer: {
          sessionId: 's1',
          answer: 'Semicolons.',
          durationMs: 1000,
          costEur: null,
          changed: false,
        },
      }),
    });
    const ask = screen.getByRole('region', { name: '1 · Ask' });
    expect(
      within(ask).getByText(
        "Answers name the pages they come from. Asking runs the brain's agent (Claude Code, sonnet) and is counted on the brain, not on this task.",
      ),
    ).toBeTruthy();
    await userEvent.type(
      within(ask).getByRole('textbox', { name: 'Question for the brain' }),
      'What was decided?',
    );
    await userEvent.click(within(ask).getByRole('button', { name: 'Ask' }));
    expect(a.calls).toContainEqual({
      channel: 'brain:ask',
      args: ['b1', 't1', 'What was decided?', null],
    });
    expect(await screen.findByText('Semicolons.')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'What was decided?' }),
    ).toBeTruthy();
    // The start is put away while the answers show, and comes back.
    expect(screen.queryByRole('region', { name: '1 · Ask' })).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: "Back to the brain's start" }),
    );
    expect(screen.getByRole('region', { name: '1 · Ask' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Show the answers (1)' }),
    ).toBeTruthy();
  });

  it('keeps a question typed while another is being answered', async () => {
    const a = show({ 'brain:ask': () => new Promise(() => undefined) });
    const ask = screen.getByRole('region', { name: '1 · Ask' });
    const box = () =>
      within(ask).getByRole('textbox', { name: 'Question for the brain' });
    await userEvent.type(box(), 'First?{Enter}');
    await userEvent.click(
      await screen.findByRole('button', { name: "Back to the brain's start" }),
    );
    await userEvent.type(box(), 'One{Shift>}{Enter}{/Shift}two{Enter}');
    expect(box()).toHaveValue('One\ntwo');
    expect(a.calls.filter((c) => c.channel === 'brain:ask')).toHaveLength(1);
  });

  it('asks each suggestion at once', async () => {
    const a = show();
    for (const s of ASK_SUGGESTIONS)
      expect(screen.getByRole('button', { name: s })).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: ASK_SUGGESTIONS[1] }),
    );
    expect(a.calls).toContainEqual({
      channel: 'brain:ask',
      args: ['b1', 't1', ASK_SUGGESTIONS[1], null],
    });
  });

  it('lists the pages for this task, and every page behind a disclosure', async () => {
    show();
    const read = screen.getByRole('region', { name: '2 · Read what applies' });
    expect(
      within(read).getByText("Picked from the work item's words. No AI used."),
    ).toBeTruthy();
    expect(
      await within(read).findByRole('button', { name: /Scope of work/ }),
    ).toBeTruthy();
    expect(within(read).queryByRole('button', { name: /Account/ })).toBeNull();
    const all = await within(read).findByText('All pages (2)');
    expect(all.closest('details')?.open).toBe(false);
    await userEvent.click(all);
    expect(
      await within(read).findByRole('button', { name: /Account/ }),
    ).toBeTruthy();
  });

  it('says so when no page mentions the task, and when the brain is empty', async () => {
    show({ 'brain:relevant': () => [] });
    expect(
      await screen.findByText(
        'No page mentions this task yet. Ask, or search.',
      ),
    ).toBeTruthy();
    cleanup();
    show({ 'brain:pages': () => [], 'brain:relevant': () => [] });
    expect(
      await screen.findByText(
        'This brain has no pages yet. Add a first document below.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/All pages/)).toBeNull();
  });

  it('opens a page in place and comes back', async () => {
    show({ 'brain:read': () => ({ text: '# Scope\n\nWhat we build.' }) });
    await userEvent.click(
      await screen.findByRole('button', { name: /Scope of work/ }),
    );
    expect(await screen.findByText('What we build.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '1 · Ask' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('region', { name: '1 · Ask' })).toBeTruthy();
  });

  it('hides the cards while a search is active', async () => {
    show({
      'brain:search': () => [
        {
          path: 'wiki/account.md',
          kind: 'page',
          title: 'Account',
          line: 3,
          text: 'Acme is the customer.',
          anchor: null,
        },
      ],
    });
    await screen.findByRole('button', { name: /Scope of work/ });
    await userEvent.type(screen.getByLabelText('Search the brain'), 'acme');
    expect(await screen.findByRole('button', { name: /Account/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Scope of work/ })).toBeNull();
    expect(screen.queryByText(/All pages/)).toBeNull();
  });

  it('takes dropped and chosen files, and sends a note to the Add view', async () => {
    show();
    const add = screen.getByRole('region', { name: '3 · Add what you learn' });
    expect(
      within(add).getByText(
        'Drop a file anywhere on this tab, or write a note',
      ),
    ).toBeTruthy();
    const dropped = Object.assign(new File(['x'], 'notes.vtt'), {
      path: '/dl/notes.vtt',
    });
    fireEvent.drop(screen.getByLabelText(/Acme brain, drop files/), {
      dataTransfer: { files: [dropped] },
    });
    expect(await screen.findByLabelText('Note for notes.vtt')).toBeTruthy();
    const chosen = Object.assign(new File(['x'], 'sow.pdf'), {
      path: '/dl/sow.pdf',
    });
    await userEvent.upload(
      screen.getByLabelText('Choose files to add'),
      chosen,
    );
    expect(await screen.findByLabelText('Note for sow.pdf')).toBeTruthy();
    await userEvent.click(
      within(add).getByRole('button', { name: 'Write a note' }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'brain',
      brainId: 'b1',
      focus: 'drop',
    });
  });

  it("opens the brain's terminal from the foot", async () => {
    const def = { id: 'brain-b1', kind: 'claude' as const, label: 'x' };
    show({ 'brain:terminal': () => def });
    await userEvent.click(
      screen.getByRole('button', { name: "Open the brain's terminal" }),
    );
    await waitFor(() => expect(onTerminal).toHaveBeenCalledWith(def));
  });
});
