import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrainPageRow,
  BrainSourceRow,
  BrainView,
} from '../../../../shared/brain';
import { useStore } from '../../../store';
import { brainJob, brainView } from '../../../test-helpers/brainFixture';
import { installFakeApi } from '../../../test-helpers/fakeApi';
import { Activity } from './Activity';

const def = { id: 'bt1', kind: 'claude' as const, label: 'Brain' };
const source = (path: string): BrainSourceRow => ({
  path,
  type: 'doc',
  ingestedAt: '2026-11-02T10:00:00.000Z',
  captured: false,
  original: null,
  contents: null,
  note: null,
});
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

function show(
  brain: BrainView,
  o: {
    sources?: BrainSourceRow[];
    rows?: BrainPageRow[];
    log?: string;
    onOpenPage?: (p: string) => void;
  } = {},
) {
  return render(
    <Activity
      brain={brain}
      sources={o.sources ?? []}
      rows={o.rows ?? []}
      log={o.log ?? ''}
      onTerminal={() => undefined}
      onOpenPage={o.onOpenPage ?? (() => undefined)}
    />,
  );
}
const runs = (a: ReturnType<typeof installFakeApi>) =>
  a.calls.filter((c) => c.channel === 'brain:run').map((c) => c.args);

beforeEach(() => useStore.setState({ notices: [] }));
afterEach(cleanup);

describe('Activity', () => {
  it('lists finished jobs newest first with Retry and Continue in terminal', async () => {
    const a = installFakeApi({
      'brain:run': () => brainJob({ id: 'j3', status: 'queued' }),
      'brain:terminal': () => def,
    });
    show(
      brainView({
        jobs: [
          brainJob({
            id: 'j1',
            source: 'sources/old.vtt',
            startedAt: '2026-11-01T10:00:00.000Z',
          }),
          brainJob({
            id: 'j2',
            source: 'sources/new.vtt',
            error: 'agent exited 1',
            startedAt: '2026-11-02T10:00:00.000Z',
          }),
        ],
      }),
    );
    const rows = within(
      screen.getByRole('list', { name: 'Earlier' }),
    ).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('new.vtt');
    expect(rows[1]).toHaveTextContent('old.vtt');
    expect(rows[0]).toHaveTextContent('agent exited 1');
    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(runs(a)).toContainEqual(['b1', 'capture', 'sources/new.vtt']);
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Continue in terminal' })[0],
    );
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:terminal',
        args: ['b1', 's-1'],
      }),
    );
  });

  it('Retry keeps the model a capture was added with, and the row names it', async () => {
    const a = installFakeApi({
      'brain:run': () => brainJob({ status: 'queued' }),
    });
    show(
      brainView({
        jobs: [brainJob({ source: 'sources/deck.pptx', model: 'opus' })],
      }),
    );
    expect(screen.getByRole('listitem')).toHaveTextContent('Opus');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(runs(a)).toEqual([['b1', 'capture', 'sources/deck.pptx', 'opus']]);
  });

  it('Continue in terminal opens a job that ran on the other agent on that agent', async () => {
    const a = installFakeApi({ 'brain:terminal': () => def });
    show(
      brainView({
        jobs: [brainJob({ id: 'j1', sessionId: 'ses_1', agent: 'opencode' })],
      }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Continue in terminal' }),
    );
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:terminal',
        args: ['b1', 'ses_1', undefined, 'opencode'],
      }),
    );
  });

  it('a source put in by hand needs you, with Capture; the wiki mirror and captured sources do not', async () => {
    const a = installFakeApi({
      'brain:run': () => brainJob({ status: 'queued' }),
    });
    show(brainView(), {
      sources: [
        source('sources/2026-11-02-sow.md'),
        { ...source('sources/k.md'), captured: true },
        source('sources/wiki/Home.md'),
      ],
    });
    const list = screen.getByRole('list', { name: 'Needs you' });
    expect(list).toHaveTextContent('2026-11-02-sow.md');
    expect(list).toHaveTextContent('not captured yet');
    expect(screen.queryByText(/Home\.md/)).toBeNull();
    expect(
      screen.getByText('Needs you · 1', { selector: '.brain-count' }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Capture sources/2026-11-02-sow.md' }),
    );
    expect(runs(a)).toEqual([['b1', 'capture', 'sources/2026-11-02-sow.md']]);
  });

  it('a waiting source whose capture failed says why and offers Retry, once', () => {
    installFakeApi();
    show(
      brainView({
        jobs: [
          brainJob({
            source: 'sources/sow.md',
            error: 'daily token cap reached',
          }),
        ],
      }),
      { sources: [source('sources/sow.md')] },
    );
    expect(screen.getByRole('list', { name: 'Needs you' })).toHaveTextContent(
      'daily token cap reached',
    );
    expect(screen.queryByRole('list', { name: 'Earlier' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('a source being captured is running, not counted as needing you', () => {
    installFakeApi();
    show(
      brainView({
        jobs: [
          brainJob({
            source: 'sources/b.md',
            status: 'running',
            endedAt: null,
            error: null,
          }),
        ],
      }),
      { sources: [source('sources/a.md'), source('sources/b.md')] },
    );
    expect(screen.getByRole('list', { name: 'Just added' })).toHaveTextContent(
      'capturing…',
    );
    expect(
      screen.getByText('Needs you · 1', { selector: '.brain-count' }),
    ).toBeInTheDocument();
  });

  it("Capture all queues one capture per source that needs you, keeping a failed one's model", async () => {
    const a = installFakeApi({
      'brain:run': () => brainJob({ status: 'queued' }),
    });
    show(
      brainView({
        jobs: [
          brainJob({ id: 'q', source: 'sources/b.md', status: 'queued' }),
          brainJob({
            id: 'f',
            source: 'sources/c.md',
            status: 'failed',
            model: 'haiku',
          }),
        ],
      }),
      {
        sources: [
          source('sources/a.md'),
          source('sources/b.md'),
          source('sources/c.md'),
        ],
      },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Capture all' }));
    expect(runs(a)).toEqual([
      ['b1', 'capture', 'sources/c.md', 'haiku'],
      ['b1', 'capture', 'sources/a.md'],
    ]);
  });

  it('a capture held by the token cap is paused and offers no Capture', () => {
    installFakeApi();
    const brain = brainView({
      jobs: [
        brainJob({
          id: 'q',
          source: 'sources/a.md',
          status: 'queued',
          error: null,
        }),
        brainJob({
          id: 'p',
          source: 'sources/b.md',
          status: 'paused',
          error: null,
        }),
      ],
    });
    brain.health = { ...brain.health!, queuePaused: 'cap' };
    show(brain, { sources: [source('sources/a.md'), source('sources/b.md')] });
    expect(screen.getAllByText('paused: daily token cap')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Capture/ })).toBeNull();
  });

  it('offers no Retry on a failed first arrangement of the book, or a paused job, and shows takeaways', async () => {
    installFakeApi();
    show(
      brainView({
        jobs: [
          brainJob({
            id: 'k',
            kind: 'sync',
            source: null,
            background: true,
            status: 'failed',
            error: 'x',
          }),
          brainJob({
            id: 'p',
            source: 'sources/p.md',
            status: 'paused',
            error: null,
          }),
          brainJob({
            id: 'd',
            source: 'sources/d.md',
            status: 'done',
            error: null,
            result: '- The SOW fixes the delivery date',
          }),
        ],
      }),
    );
    expect(screen.getByText('x')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await userEvent.click(screen.getByText('Takeaways'));
    expect(
      screen.getByText('- The SOW fixes the delivery date'),
    ).toBeInTheDocument();
  });

  it('links a done capture to the pages it changed', async () => {
    installFakeApi();
    const onOpenPage = vi.fn();
    show(
      brainView({
        jobs: [
          brainJob({
            status: 'done',
            error: null,
            source: 'sources/2026-11-02-sow.md',
          }),
        ],
      }),
      {
        rows: [page('wiki/a.md', 'A'), page('wiki/b.md', 'B')],
        log: '- 2026-11-02T10:00:30.000Z /capture sources/2026-11-02-sow.md → pages: a, b; takeaway: x\n',
        onOpenPage,
      },
    );
    await userEvent.click(
      screen.getByRole('button', { name: '2 pages changed' }),
    );
    expect(onOpenPage).toHaveBeenCalledWith('wiki/a.md');
  });

  it('filters to what needs you or what runs', async () => {
    installFakeApi();
    show(
      brainView({
        jobs: [
          brainJob({
            id: 'r',
            source: 'sources/r.md',
            status: 'running',
            error: null,
          }),
          brainJob({
            id: 'l',
            kind: 'lint',
            source: null,
            status: 'done',
            error: null,
          }),
        ],
      }),
      { sources: [source('sources/r.md'), source('sources/n.md')] },
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Running · 1' }));
    expect(
      screen.getByRole('list', { name: 'Just added' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Needs you' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Earlier' })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Needs you · 1' }));
    expect(screen.getByRole('list', { name: 'Needs you' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Just added' })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Done' }));
    expect(screen.getByRole('list', { name: 'Earlier' })).toHaveTextContent(
      'lint',
    );
  });

  it('lists conflicts to settle under Needs you, and an answer source waiting for its settle is not one', async () => {
    installFakeApi();
    const onSettle = vi.fn();
    render(
      <Activity
        brain={brainView()}
        sources={[source('sources/answer.md')]}
        rows={[]}
        log=""
        conflicts={2}
        answers={['sources/answer.md']}
        onSettle={onSettle}
        onOpenPage={() => undefined}
      />,
    );
    const needs = screen.getByRole('list', { name: 'Needs you' });
    expect(needs).toHaveTextContent('Conflicts to settle · 2');
    expect(needs).not.toHaveTextContent('answer.md');
    expect(
      screen.getByText('Needs you · 2', { selector: '.brain-count' }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(needs).getByRole('button', { name: 'Settle' }),
    );
    expect(onSettle).toHaveBeenCalled();
  });

  it('keeps a way to conflicts that only wait on someone, without counting them', async () => {
    installFakeApi();
    const onSettle = vi.fn();
    render(
      <Activity
        brain={brainView()}
        sources={[]}
        rows={[]}
        log=""
        conflicts={0}
        parkedConflicts={1}
        onSettle={onSettle}
        onOpenPage={() => undefined}
      />,
    );
    const needs = screen.getByRole('list', { name: 'Needs you' });
    expect(needs).toHaveTextContent('Conflicts waiting on someone · 1');
    expect(
      screen.queryByText(/Needs you · /, { selector: '.brain-count' }),
    ).toBeNull();
    await userEvent.click(within(needs).getByRole('button', { name: 'Open' }));
    expect(onSettle).toHaveBeenCalled();
  });

  it('a failed write names what it was for, and Retry asks for the same long read', async () => {
    const a = installFakeApi({
      'brain:write': () => brainJob({ kind: 'write', status: 'queued' }),
    });
    show(
      brainView({
        jobs: [
          brainJob({ kind: 'write', source: null, target: 'chapter:Orders' }),
        ],
      }),
    );
    expect(screen.getByRole('listitem')).toHaveTextContent('chapter Orders');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(a.calls).toContainEqual({
      channel: 'brain:write',
      args: ['b1', 'chapter:Orders'],
    });
    expect(runs(a)).toEqual([]);
  });

  it('says so when nothing happened yet', () => {
    installFakeApi();
    show(brainView({ jobs: [] }));
    expect(screen.getByText('Nothing added yet.')).toBeInTheDocument();
  });
});
