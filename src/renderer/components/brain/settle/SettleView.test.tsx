import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrainConflictRow,
  BrainConflicts,
  BrainPageRow,
  BrainView,
} from '../../../../shared/brain';
import { useStore } from '../../../store';
import { brainView } from '../../../test-helpers/brainFixture';
import { installFakeApi } from '../../../test-helpers/fakeApi';
import { askedWho, setAskedWho } from './askStore';
import { SettleView } from './SettleView';

const page = (path: string, title: string): BrainPageRow => ({
  path,
  title,
  summary: '',
  type: 'other',
  lastUpdated: null,
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
  pictures: [],
});
const ROWS = [
  page('wiki/plan.md', 'Plan and milestones'),
  page('wiki/meeting-steerco.md', 'Steerco 5 Nov'),
  page('wiki/scope-integrations.md', 'Scope: integrations'),
];
const goLive: BrainConflictRow = {
  id: 'c-go-live',
  kind: 'contradiction',
  page: 'wiki/plan.md',
  detail: 'go-live differs',
  at: '2026-11-10T08:41:00.000Z',
  conflict: {
    id: 'c-go-live',
    question: 'When does Acme go live?',
    claims: {
      a: {
        page: 'wiki/plan.md',
        quote: 'Go-live is 12 January.',
        source: 'sources/2026-10-28-sow-v2.md',
        date: '2026-10-28',
      },
      b: {
        page: 'wiki/meeting-steerco.md',
        quote: 'Go-live moves to 2 February.',
        source: 'sources/2026-11-10-steerco.md',
        date: '2026-11-10',
      },
    },
    suggestion: { pick: 'b', reason: 'B is newer and a steerco decision.' },
    reopens: null,
  },
};
const crm: BrainConflictRow = {
  id: 'c-crm',
  kind: 'scope-change',
  page: 'wiki/scope-integrations.md',
  detail: 'CRM sync requested',
  at: '2026-11-10T08:40:00.000Z',
  conflict: {
    id: 'c-crm',
    question: 'Is the CRM sync part of phase 1?',
    claims: {
      a: {
        page: 'wiki/scope-integrations.md',
        quote: 'CRM is out of scope.',
        source: null,
        date: null,
      },
      b: {
        page: 'sources/2026-11-10-steerco.md',
        quote: 'Add the CRM sync to phase 1.',
        source: 'sources/2026-11-10-steerco.md',
        date: '2026-11-10',
      },
    },
    suggestion: null,
    reopens: null,
  },
};
const old: BrainConflictRow = {
  id: 'contradiction:wiki/plan.md:budget differs from the SOW',
  kind: 'contradiction',
  page: 'wiki/plan.md',
  detail: 'budget differs from the SOW',
  at: '2026-11-09T08:00:00.000Z',
  conflict: null,
};
const none: BrainConflicts = { open: [], parked: [], settled: [], answers: [] };

function Host({
  brain = brainView({ templatesVersion: 9 }),
  conflicts,
  initial = null,
  onOpenPage = () => undefined,
}: {
  brain?: BrainView;
  conflicts: BrainConflicts;
  initial?: string | null;
  onOpenPage?: (p: string) => void;
}) {
  const [target, setTarget] = useState<string | null>(initial);
  return (
    <>
      <span data-testid="target">{target ?? 'list'}</span>
      <SettleView
        brain={brain}
        conflicts={conflicts}
        rows={ROWS}
        target={target}
        onTarget={setTarget}
        onBack={() => undefined}
        onOpenPage={onOpenPage}
      />
    </>
  );
}
const calls = (a: ReturnType<typeof installFakeApi>, channel: string) =>
  a.calls.filter((c) => c.channel === channel).map((c) => c.args);

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ notices: [] });
});
afterEach(cleanup);

describe('SettleView: one conflict', () => {
  it("shows the question, both claims with page, source and date, the newer one and the agent's read", () => {
    installFakeApi();
    const onOpenPage = vi.fn();
    render(
      <Host
        conflicts={{ ...none, open: [goLive, crm] }}
        initial="c-go-live"
        onOpenPage={onOpenPage}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'When does Acme go live?' }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    const a = screen.getByRole('group', { name: 'Claim A' });
    expect(a).toHaveTextContent('Plan and milestones');
    expect(a).toHaveTextContent('Go-live is 12 January.');
    expect(a).toHaveTextContent('2026-10-28-sow-v2.md');
    expect(a).not.toHaveTextContent('Newer');
    expect(screen.getByRole('group', { name: 'Claim B' })).toHaveTextContent(
      'Newer',
    );
    expect(
      screen.getByText('B is newer and a steerco decision.'),
    ).toBeInTheDocument();
    fireEvent.click(within(a).getByRole('button', { name: 'Open page' }));
    expect(onOpenPage).toHaveBeenCalledWith('wiki/plan.md');
  });

  it('preselects nothing, marks the suggestion, and settles with the choice and why, then moves on', async () => {
    const a = installFakeApi({ 'brain:settle': () => undefined });
    render(
      <Host conflicts={{ ...none, open: [goLive, crm] }} initial="c-go-live" />,
    );
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked();
    expect(
      screen.getByRole('radio', { name: /B is right/ }).closest('label'),
    ).toHaveTextContent('Suggested');
    expect(screen.getByRole('button', { name: /^Settle/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: /B is right/ }));
    fireEvent.change(screen.getByLabelText('Why'), {
      target: { value: 'Steerco moved it' },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Settle: B is right' }),
    );
    await waitFor(() =>
      expect(calls(a, 'brain:settle')).toEqual([
        [
          'b1',
          {
            id: 'c-go-live',
            kind: 'contradiction',
            page: 'wiki/plan.md',
            question: 'When does Acme go live?',
            detail: 'go-live differs',
            claims: goLive.conflict!.claims,
            choice: 'b',
            text: null,
            why: 'Steerco moved it',
            answer: null,
          },
        ],
      ]),
    );
    expect(screen.getByTestId('target')).toHaveTextContent('c-crm');
  });

  it('asks how both fit, or what is true, before it settles', async () => {
    const a = installFakeApi({ 'brain:settle': () => undefined });
    render(
      <Host conflicts={{ ...none, open: [goLive] }} initial="c-go-live" />,
    );
    await userEvent.click(screen.getByRole('radio', { name: /Neither/ }));
    const settle = screen.getByRole('button', { name: 'Settle: neither' });
    expect(settle).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What is true'), {
      target: { value: '1 March' },
    });
    await userEvent.click(settle);
    await waitFor(() =>
      expect(calls(a, 'brain:settle')[0]?.[1]).toMatchObject({
        choice: 'neither',
        text: '1 March',
        why: null,
      }),
    );
    expect(screen.getByTestId('target')).toHaveTextContent('list');
  });

  it('offers accept or keep for a scope change', async () => {
    const a = installFakeApi({ 'brain:settle': () => undefined });
    render(<Host conflicts={{ ...none, open: [crm] }} initial="c-crm" />);
    expect(
      screen.getByRole('group', { name: 'Agreed scope' }),
    ).toHaveTextContent('CRM is out of scope.');
    expect(screen.getByRole('group', { name: 'New source' })).toHaveTextContent(
      'Add the CRM sync to phase 1.',
    );
    expect(screen.queryByRole('radio', { name: /A is right/ })).toBeNull();
    await userEvent.click(
      screen.getByRole('radio', { name: /Keep the agreed scope/ }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Settle: keep the agreed scope' }),
    );
    await waitFor(() =>
      expect(calls(a, 'brain:settle')[0]?.[1]).toMatchObject({
        choice: 'keep',
        kind: 'scope-change',
      }),
    );
  });

  it('parks with a ready question, keeps who to ask on this machine only, and copies the question', async () => {
    const a = installFakeApi({ 'brain:park': () => undefined });
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <Host conflicts={{ ...none, open: [goLive] }} initial="c-go-live" />,
    );
    await userEvent.click(
      screen.getByRole('radio', { name: /I need to ask someone/ }),
    );
    const question = screen.getByLabelText(
      'The question',
    ) as HTMLTextAreaElement;
    expect(question.value).toContain('Go-live is 12 January.');
    expect(question.value).toContain('Go-live moves to 2 February.');
    fireEvent.change(screen.getByLabelText('Who can answer'), {
      target: { value: 'Customer PM' },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Copy question' }),
    );
    expect(writeText).toHaveBeenCalledWith(question.value);
    await userEvent.click(
      screen.getByRole('button', { name: 'Park: waiting on Customer PM' }),
    );
    await waitFor(() =>
      expect(calls(a, 'brain:park')).toEqual([
        ['b1', 'c-go-live', question.value],
      ]),
    );
    expect(askedWho('b1', 'c-go-live')).toBe('Customer PM');
    expect(JSON.stringify(a.calls)).not.toContain('Customer PM');
  });

  it('an older finding offers Write what is true and Re-check, and cannot be parked', async () => {
    const a = installFakeApi({
      'brain:settle': () => undefined,
      'brain:run': () => ({}) as never,
    });
    render(<Host conflicts={{ ...none, open: [old] }} initial={old.id} />);
    expect(screen.getByText('budget differs from the SOW')).toBeInTheDocument();
    expect(
      screen.queryByRole('radio', { name: /I need to ask someone/ }),
    ).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(calls(a, 'brain:run')).toEqual([['b1', 'lint']]);
    await userEvent.click(
      screen.getByRole('radio', { name: /Write what is true/ }),
    );
    fireEvent.change(screen.getByLabelText('What is true'), {
      target: { value: 'EUR 120k' },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Settle: write what is true' }),
    );
    await waitFor(() =>
      expect(calls(a, 'brain:settle')[0]?.[1]).toMatchObject({
        choice: 'write',
        text: 'EUR 120k',
        claims: null,
      }),
    );
  });

  it('says skills need an update below v9 and settles nothing', () => {
    installFakeApi();
    render(
      <Host
        brain={brainView({ templatesVersion: 8 })}
        conflicts={{ ...none, open: [goLive] }}
        initial="c-go-live"
      />,
    );
    expect(
      screen.getByText('Update skills to settle conflicts here'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /B is right/ }));
    expect(
      screen.getByRole('button', { name: 'Settle: B is right' }),
    ).toBeDisabled();
  });
});

describe('SettleView: the list', () => {
  it('groups what needs you, what waits on someone and what was settled', async () => {
    installFakeApi({ 'brain:settleRetry': () => undefined });
    setAskedWho('b1', 'c-crm', 'Customer PM');
    const onOpenPage = vi.fn();
    render(
      <Host
        onOpenPage={onOpenPage}
        conflicts={{
          open: [goLive],
          parked: [
            {
              ...crm,
              question: 'Is CRM in?',
              parkedAt: '2026-11-10T20:14:00.000Z',
            },
          ],
          settled: [
            {
              id: 's1',
              question: 'Which endpoint?',
              choice: 'both',
              text: 'old until March',
              at: '2026-11-09T10:00:00.000Z',
              status: 'done',
              page: 'wiki/decision-2026-11-09-endpoint.md',
              error: null,
            },
            {
              id: 's2',
              question: 'Who signs off?',
              choice: 'a',
              text: null,
              at: '2026-11-10T10:00:00.000Z',
              status: 'failed',
              page: null,
              error: 'agent exited 1',
            },
          ],
          answers: [],
        }}
      />,
    );
    const needs = screen.getByRole('region', { name: 'Needs you · 1' });
    await userEvent.click(
      within(needs).getByRole('button', { name: 'Settle' }),
    );
    expect(screen.getByTestId('target')).toHaveTextContent('c-go-live');
    cleanup();
  });

  it('shows who was asked, the settled choices, a decision page and Retry', async () => {
    const a = installFakeApi({ 'brain:settleRetry': () => undefined });
    setAskedWho('b1', 'c-crm', 'Customer PM');
    const onOpenPage = vi.fn();
    render(
      <Host
        onOpenPage={onOpenPage}
        conflicts={{
          open: [],
          parked: [
            {
              ...crm,
              question: 'Is CRM in?',
              parkedAt: '2026-11-10T20:14:00.000Z',
            },
          ],
          settled: [
            {
              id: 's1',
              question: 'Which endpoint?',
              choice: 'both',
              text: 'old until March',
              at: '2026-11-09T10:00:00.000Z',
              status: 'done',
              page: 'wiki/decision-2026-11-09-endpoint.md',
              error: null,
            },
            {
              id: 's2',
              question: 'Who signs off?',
              choice: 'a',
              text: null,
              at: '2026-11-10T10:00:00.000Z',
              status: 'failed',
              page: null,
              error: 'agent exited 1',
            },
          ],
          answers: [],
        }}
      />,
    );
    expect(
      screen.getByRole('region', { name: 'Waiting on someone · 1' }),
    ).toHaveTextContent('Asked Customer PM');
    const settled = screen.getByRole('region', { name: 'Settled' });
    expect(settled).toHaveTextContent('Both: old until March');
    expect(settled).toHaveTextContent('agent exited 1');
    await userEvent.click(
      within(settled).getByRole('button', { name: 'Decision page' }),
    );
    expect(onOpenPage).toHaveBeenCalledWith(
      'wiki/decision-2026-11-09-endpoint.md',
    );
    await userEvent.click(
      within(settled).getByRole('button', { name: 'Retry' }),
    );
    expect(calls(a, 'brain:settleRetry')).toEqual([['b1', 's2']]);
  });

  it('Got an answer hands the reply to main, then the conflict opens with the answer it keeps', async () => {
    const a = installFakeApi({
      'brain:answer': () => ({ path: 'sources/2026-11-10-answer.md' }),
      'brain:settle': () => undefined,
    });
    const parked = {
      ...crm,
      question: 'Is CRM in?',
      parkedAt: '2026-11-10T20:14:00.000Z',
    };
    const { rerender } = render(
      <Host conflicts={{ ...none, parked: [parked] }} />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Got an answer' }),
    );
    fireEvent.change(screen.getByLabelText('Their answer'), {
      target: { value: 'Yes, CRM is in phase 1.' },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Add answer and settle' }),
    );
    await waitFor(() =>
      expect(calls(a, 'brain:answer')).toEqual([
        ['b1', 'c-crm', 'Yes, CRM is in phase 1.'],
      ]),
    );
    await waitFor(() =>
      expect(screen.getByTestId('target')).toHaveTextContent('c-crm'),
    );
    // Main keeps the answer on the conflict, so it is there however the view was left and opened again.
    rerender(
      <Host
        conflicts={{
          ...none,
          open: [
            {
              ...crm,
              answer: {
                path: 'sources/2026-11-10-answer.md',
                text: 'Yes, CRM is in phase 1.',
              },
            },
          ],
        }}
        initial="c-crm"
      />,
    );
    expect(
      await screen.findByText('Yes, CRM is in phase 1.'),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('radio', { name: /Accept: this is the new scope/ }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Settle: accept the new scope' }),
    );
    await waitFor(() =>
      expect(calls(a, 'brain:settle')[0]?.[1]).toMatchObject({
        choice: 'accept',
        answer: 'sources/2026-11-10-answer.md',
      }),
    );
  });

  it('says so when there is nothing to settle, and names no agent', () => {
    installFakeApi();
    const { container } = render(<Host conflicts={none} />);
    expect(
      screen.getByText(
        'Nothing to settle. Lint raises conflicts here when pages or sources disagree.',
      ),
    ).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/claude|opencode/i);
  });
});
