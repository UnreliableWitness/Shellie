import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AddSourceResult,
  BrainPageRow,
  BrainSourceRow,
  BrainWiki,
} from '../../../shared/brain';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { brainJob, brainView } from '../../test-helpers/brainFixture';
import { BrainAdd } from './BrainAdd';

const file = (name: string, path = `/dl/${name}`) =>
  Object.assign(new File(['x'], name), { path });
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
});

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    notices: [],
    screen: { kind: 'brain', brainId: 'b1' },
    brainPending: {},
  });
});

describe('BrainAdd', () => {
  it('dropped files wait with guessed types until Add sends them', async () => {
    const a = installFakeApi({
      'brain:addFiles': () => [
        { ok: true, path: 'sources/x', images: 0, warnings: [], contents: '' },
        { ok: true, path: 'sources/y', images: 0, warnings: [], contents: '' },
        { ok: true, path: 'sources/z', images: 0, warnings: [], contents: '' },
      ],
    });
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: {
        files: [file('kickoff.vtt'), file('plan.pptx'), file('sow.docx')],
      },
    });
    const list = await screen.findByRole('form', { name: 'Files to add' });
    expect(list).toHaveTextContent('kickoff.vtt');
    expect(screen.getByLabelText('Type of kickoff.vtt')).toHaveValue(
      'transcript',
    );
    expect(screen.getByLabelText('Type of plan.pptx')).toHaveValue('deck');
    expect(a.calls.filter((c) => c.channel === 'brain:addFiles')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Add 3 files' }));
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:addFiles',
        args: [
          'b1',
          [
            { path: '/dl/kickoff.vtt', type: 'transcript' },
            { path: '/dl/plan.pptx', type: 'deck' },
            { path: '/dl/sow.docx', type: 'doc' },
          ],
        ],
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Files to add' })).toBeNull(),
    );
  });

  it('takes a type and a note per file, drops a removed one, and sends them with Enter', async () => {
    const a = installFakeApi({
      'brain:addFiles': () => [
        { ok: true, path: 'sources/x', images: 0, warnings: [], contents: '' },
      ],
    });
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('sow.docx'), file('old.docx')] },
    });
    // The same path dropped again is not listed twice.
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('sow.docx')] },
    });
    expect(await screen.findAllByLabelText(/^Type of /)).toHaveLength(2);
    await userEvent.selectOptions(
      screen.getByLabelText('Type of sow.docx'),
      'sow',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove old.docx' }),
    );
    expect(screen.queryByLabelText('Type of old.docx')).toBeNull();
    await userEvent.type(
      screen.getByLabelText('Note for sow.docx'),
      ' Signed version; supersedes the draft {enter}',
    );
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:addFiles',
        args: [
          'b1',
          [
            {
              path: '/dl/sow.docx',
              type: 'sow',
              note: 'Signed version; supersedes the draft',
            },
          ],
        ],
      }),
    );
  });

  it('keeps waiting files across a remount, keeps files dropped during an add, and reports a file with no path', async () => {
    let answer: (r: AddSourceResult[]) => void = () => undefined;
    const a = installFakeApi({
      'brain:addFiles': () => new Promise((res) => (answer = res)),
    });
    const { unmount } = render(
      <BrainAdd brain={brainView()} onOpenPage={() => undefined} />,
    );
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('a.docx')] },
    });
    await userEvent.type(
      await screen.findByLabelText('Note for a.docx'),
      'first',
    );
    unmount();
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    expect(screen.getByLabelText('Note for a.docx')).toHaveValue('first');
    await userEvent.click(screen.getByRole('button', { name: 'Add 1 file' }));
    expect(screen.getByLabelText('Note for a.docx')).toBeDisabled();
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('b.docx'), file('ghost.png', '')] },
    });
    expect(
      await screen.findByText('ghost.png: not a file on disk'),
    ).toBeInTheDocument();
    answer([
      { ok: true, path: 'sources/a.md', images: 0, warnings: [], contents: '' },
    ]);
    await waitFor(() =>
      expect(screen.queryByLabelText('Note for a.docx')).toBeNull(),
    );
    expect(screen.getByLabelText('Note for b.docx')).toBeInTheDocument();
    expect(a.calls.filter((c) => c.channel === 'brain:addFiles')).toHaveLength(
      1,
    );
  });

  it('says what a drop added, with pictures and what conversion left out', async () => {
    installFakeApi({
      'brain:addFiles': () => [
        {
          ok: true,
          path: 'sources/2026-11-04-plan.md',
          images: 3,
          warnings: ['1 picture in formats Claude cannot view (emf)'],
          contents: '12 slides · 3 pictures: Kick-off',
        },
        {
          ok: true,
          path: 'sources/2026-11-04-sow.md',
          images: 0,
          warnings: [],
          contents: '',
        },
      ],
    });
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('plan.pptx'), file('sow.docx')] },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add 2 files' }),
    );
    const added = await screen.findByLabelText('Added');
    expect(added).toHaveTextContent(
      'Added 2026-11-04-plan.md · 12 slides · 3 pictures: Kick-off',
    );
    expect(added).toHaveTextContent(
      '2026-11-04-plan.md: 1 picture in formats Claude cannot view (emf)',
    );
    expect(added).toHaveTextContent('Added 2026-11-04-sow.md');
    expect(added).not.toHaveTextContent('sow.md ·');
  });

  it('shows what a drop could not add', async () => {
    installFakeApi({
      'brain:addFiles': () => [
        {
          ok: false,
          reason: 'duplicate',
          message: 'kickoff.vtt is already in the brain',
        },
      ],
    });
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('kickoff.vtt')] },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add 1 file' }),
    );
    expect(await screen.findByText(/already in the brain/)).toBeInTheDocument();
  });

  it('pasting text sends title, text and type to brain:addText', async () => {
    const a = installFakeApi({
      'brain:addText': () => ({
        ok: true,
        path: 'sources/n.md',
        images: 0,
        warnings: [],
        contents: '',
      }),
    });
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    await userEvent.type(screen.getByLabelText('Title'), 'Call notes');
    await userEvent.type(screen.getByLabelText('Text'), 'we agreed on X');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'note');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:addText',
        args: ['b1', 'we agreed on X', 'Call notes', 'note'],
      }),
    );
    expect(screen.getByLabelText('Text')).toHaveValue('');
  });

  it('sends the note with pasted text and clears it', async () => {
    const a = installFakeApi({
      'brain:addText': () => ({
        ok: true,
        path: 'sources/n.md',
        images: 0,
        warnings: [],
        contents: '',
      }),
    });
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    await userEvent.type(screen.getByLabelText('Text'), 'we agreed on X');
    await userEvent.type(screen.getByLabelText('Note'), ' From memory, check ');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:addText',
        args: ['b1', 'we agreed on X', '', 'note', 'From memory, check'],
      }),
    );
    expect(screen.getByLabelText('Note')).toHaveValue('');
  });

  it('lists jobs newest first with Retry and Continue in terminal', async () => {
    const a = installFakeApi({
      'brain:run': () => brainJob({ id: 'j3', status: 'queued' }),
      'brain:terminal': () => def,
    });
    const brain = brainView({
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
    });
    render(<BrainAdd brain={brain} onOpenPage={() => undefined} />);
    const rows = within(
      screen.getByRole('list', { name: 'Recent work' }),
    ).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('new.vtt');
    expect(rows[1]).toHaveTextContent('old.vtt');
    expect(rows[0]).toHaveTextContent('agent exited 1');
    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(a.calls).toContainEqual({
      channel: 'brain:run',
      args: ['b1', 'capture', 'sources/new.vtt'],
    });
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

  it('lists uncaptured sources (not the wiki mirror) with Capture', async () => {
    const a = installFakeApi({
      'brain:sources': () => [
        {
          path: 'sources/2026-11-02-sow.md',
          type: 'sow',
          ingestedAt: '2026-11-02T10:00:00.000Z',
          captured: false,
          original: null,
          contents: null,
          note: null,
        },
        {
          path: 'sources/2026-11-01-kickoff.md',
          type: 'transcript',
          ingestedAt: '2026-11-01T10:00:00.000Z',
          captured: true,
          original: null,
          contents: null,
          note: null,
        },
        {
          path: 'sources/wiki/Home.md',
          type: 'wiki-page',
          ingestedAt: '2026-11-01T10:00:00.000Z',
          captured: false,
          original: null,
          contents: null,
          note: null,
        },
      ],
      'brain:run': () => brainJob({ status: 'queued' }),
    });
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    const list = await screen.findByRole('list', {
      name: 'Waiting to capture',
    });
    expect(list).toHaveTextContent('2026-11-02-sow.md');
    expect(list).toHaveTextContent('not captured yet');
    expect(list).not.toHaveTextContent('kickoff');
    expect(list).not.toHaveTextContent('Home.md');
    await userEvent.click(
      screen.getByRole('button', { name: 'Capture sources/2026-11-02-sow.md' }),
    );
    expect(a.calls).toContainEqual({
      channel: 'brain:run',
      args: ['b1', 'capture', 'sources/2026-11-02-sow.md'],
    });
  });

  it('offers no Retry on a paused job and shows takeaways of a done one', async () => {
    installFakeApi({});
    const brain = brainView({
      jobs: [
        brainJob({ id: 'p', status: 'paused', error: null }),
        brainJob({
          id: 'd',
          status: 'done',
          error: null,
          result: '- The SOW fixes the delivery date',
        }),
      ],
    });
    render(<BrainAdd brain={brain} onOpenPage={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByText('Takeaways')).toBeInTheDocument();
    expect(
      screen.getByText('- The SOW fixes the delivery date'),
    ).toBeInTheDocument();
  });

  it('explains the four steps, and Hide is remembered across a remount', async () => {
    installFakeApi({});
    const { unmount } = render(
      <BrainAdd brain={brainView()} onOpenPage={() => undefined} />,
    );
    const how = screen.getByRole('region', { name: 'How it works' });
    expect(how).toHaveTextContent('1 · You add');
    expect(how).toHaveTextContent(
      'Drop a file or paste text. It is stored untouched under sources/.',
    );
    expect(how).toHaveTextContent('2 · Capture (auto)');
    expect(how).toHaveTextContent(
      'The agent reads the source and writes or updates wiki pages.',
    );
    expect(how).toHaveTextContent('3 · Lint (auto)');
    expect(how).toHaveTextContent(
      'After each successful capture: checks for broken links, contradictions and gaps.',
    );
    expect(how).toHaveTextContent('4 · Read');
    expect(how).toHaveTextContent(
      'New and changed pages get a blue dot in Read.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('1 · You add')).toBeNull();
    unmount();
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    expect(screen.queryByText('1 · You add')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'How it works' }));
    expect(screen.getByText('1 · You add')).toBeInTheDocument();
  });

  it('says a waiting source failed, with its error, and offers Capture', async () => {
    installFakeApi({
      'brain:sources': () => [source('sources/2026-11-02-sow.md')],
    });
    const brain = brainView({
      jobs: [
        brainJob({
          source: 'sources/2026-11-02-sow.md',
          error: 'daily token cap reached',
        }),
      ],
    });
    render(<BrainAdd brain={brain} onOpenPage={() => undefined} />);
    const list = await screen.findByRole('list', {
      name: 'Waiting to capture',
    });
    expect(list).toHaveTextContent('daily token cap reached');
    expect(
      screen.getByRole('heading', { name: /Waiting to capture · 1/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Capture sources/2026-11-02-sow.md' }),
    ).toBeEnabled();
  });

  it('Capture all queues one capture per waiting source not queued or running', async () => {
    const a = installFakeApi({
      'brain:sources': () => [
        source('sources/a.md'),
        source('sources/b.md'),
        source('sources/c.md'),
      ],
      'brain:run': () => brainJob({ status: 'queued' }),
    });
    const brain = brainView({
      jobs: [
        brainJob({ id: 'q', source: 'sources/b.md', status: 'queued' }),
        brainJob({ id: 'f', source: 'sources/c.md', status: 'failed' }),
      ],
    });
    render(<BrainAdd brain={brain} onOpenPage={() => undefined} />);
    expect(
      await screen.findByRole('button', { name: 'Capture sources/b.md' }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Capture all' }));
    const runs = a.calls.filter((c) => c.channel === 'brain:run');
    expect(runs).toEqual([
      { channel: 'brain:run', args: ['b1', 'capture', 'sources/a.md'] },
      { channel: 'brain:run', args: ['b1', 'capture', 'sources/c.md'] },
    ]);
  });

  it('keeps a capture held by the token cap from being queued again', async () => {
    const a = installFakeApi({
      'brain:sources': () => [
        source('sources/a.md'),
        source('sources/b.md'),
        source('sources/c.md'),
      ],
      'brain:run': () => brainJob({ status: 'queued' }),
    });
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
    render(<BrainAdd brain={brain} onOpenPage={() => undefined} />);
    const list = await screen.findByRole('list', {
      name: 'Waiting to capture',
    });
    expect(within(list).getAllByText('paused: daily token cap')).toHaveLength(
      2,
    );
    expect(
      screen.getByRole('button', { name: 'Capture sources/a.md' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Capture sources/b.md' }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Capture all' }));
    expect(a.calls.filter((c) => c.channel === 'brain:run')).toEqual([
      { channel: 'brain:run', args: ['b1', 'capture', 'sources/c.md'] },
    ]);
  });

  it('links a done capture to the pages it changed', async () => {
    installFakeApi({
      'brain:pages': () => [page('wiki/a.md', 'A'), page('wiki/b.md', 'B')],
      'brain:read': () => ({
        text: '- 2026-11-02T10:00:30.000Z /capture sources/2026-11-02-sow.md → pages: a, b; takeaway: x\n',
      }),
    });
    const onOpenPage = vi.fn();
    const brain = brainView({
      jobs: [
        brainJob({
          status: 'done',
          error: null,
          source: 'sources/2026-11-02-sow.md',
        }),
      ],
    });
    render(<BrainAdd brain={brain} onOpenPage={onOpenPage} />);
    await userEvent.click(
      await screen.findByRole('button', { name: '2 pages changed' }),
    );
    expect(onOpenPage).toHaveBeenCalledWith('wiki/a.md');
  });

  it('names no agent', async () => {
    installFakeApi({
      'brain:sources': () => [source('sources/a.md')],
    });
    const brain = brainView({
      jobs: [
        brainJob({
          id: 'r',
          source: 'sources/x.md',
          status: 'running',
          error: null,
        }),
        brainJob({
          id: 'd',
          source: 'sources/y.md',
          status: 'done',
          error: null,
        }),
      ],
    });
    const { container } = render(
      <BrainAdd brain={brain} onOpenPage={() => undefined} />,
    );
    await screen.findByRole('list', { name: 'Waiting to capture' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Help: Waiting to capture' }),
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Dropped and pasted sources are captured automatically.',
    );
    expect(document.body.textContent).not.toMatch(/claude|opencode/i);
    expect(container.innerHTML).not.toMatch(/claude|opencode/i);
  });
});

const wiki: BrainWiki = {
  wikiId: 'w1',
  wikiName: 'Shellie.wiki',
  type: 'projectWiki',
  repositoryId: 'r1',
  gitUrl: 'https://dev.azure.com/x/_git/w',
  version: 'wikiMaster',
  mappedPath: '/',
  rootPath: '/',
};
const withOptions = (
  over: Partial<ReturnType<typeof brainView>['options']>,
  wikiOf: BrainWiki | null = wiki,
) => {
  const b = brainView({ wiki: wikiOf });
  return { ...b, options: { ...b.options, ...over } };
};

describe('BrainAdd right column', () => {
  it('lists what runs by itself, with the task-start refresh when Context in task.md is on', async () => {
    installFakeApi({});
    render(
      <BrainAdd
        brain={withOptions({ contextInTaskMd: true })}
        onOpenPage={() => undefined}
      />,
    );
    const card = await screen.findByRole('region', {
      name: 'What runs by itself',
    });
    expect(card).toHaveTextContent('Capture after you addautoalways');
    expect(card).toHaveTextContent(
      'Lint after each captureautoafter each successful capture',
    );
    expect(card).toHaveTextContent(
      'Refresh the DevOps wikiautowhen older than a day, while Shellie is open · at task start',
    );
    expect(card).toHaveTextContent('Sync after a refresh');
    expect(card).toHaveTextContent('Weekly digest');
    expect(card).toHaveTextContent(
      'Daily token cap12,345 of 500,000 tokens · €0.42 today',
    );
    expect(
      within(card).getByRole('switch', { name: 'Sync after a refresh' }),
    ).not.toBeChecked();
  });

  it('leaves out the task-start refresh when Context in task.md is off', async () => {
    installFakeApi({});
    render(
      <BrainAdd
        brain={withOptions({ contextInTaskMd: false })}
        onOpenPage={() => undefined}
      />,
    );
    const card = await screen.findByRole('region', {
      name: 'What runs by itself',
    });
    expect(card).toHaveTextContent(
      'when older than a day, while Shellie is open',
    );
    expect(card).not.toHaveTextContent('at task start');
  });

  it('without a wiki: no refresh row, no sync switch, no Refresh wiki button', async () => {
    installFakeApi({});
    render(
      <BrainAdd brain={withOptions({}, null)} onOpenPage={() => undefined} />,
    );
    const card = await screen.findByRole('region', {
      name: 'What runs by itself',
    });
    expect(card).not.toHaveTextContent('Refresh the DevOps wiki');
    expect(
      screen.queryByRole('switch', { name: 'Sync after a refresh' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh wiki' })).toBeNull();
    expect(
      screen.getByRole('switch', { name: 'Weekly digest' }),
    ).toBeInTheDocument();
  });

  it('toggling Weekly digest writes the option', async () => {
    const a = installFakeApi({ 'brain:update': () => brainView() });
    render(<BrainAdd brain={withOptions({})} onOpenPage={() => undefined} />);
    await userEvent.click(
      screen.getByRole('switch', { name: 'Weekly digest' }),
    );
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:update',
        args: ['b1', { options: { weeklyDigest: true } }],
      }),
    );
    expect(a.tracked).toContainEqual(
      expect.objectContaining({
        name: 'brain.screen.action',
        props: { action: 'option' },
      }),
    );
  });

  it('a paused queue shows paused and Resume on the token cap row', async () => {
    const a = installFakeApi({ 'brain:resumeQueue': () => undefined });
    const brain = withOptions({});
    brain.health = { ...brain.health!, queuePaused: 'cap' };
    render(<BrainAdd brain={brain} onOpenPage={() => undefined} />);
    const card = screen.getByRole('region', { name: 'What runs by itself' });
    expect(card).toHaveTextContent('paused');
    await userEvent.click(within(card).getByRole('button', { name: 'Resume' }));
    expect(a.calls).toContainEqual({
      channel: 'brain:resumeQueue',
      args: ['b1'],
    });
  });

  it('Run now: Sync runs a sync, and its ? explains it', async () => {
    const a = installFakeApi({
      'brain:run': (brainId, kind) => brainJob({ brainId, kind }),
    });
    render(<BrainAdd brain={withOptions({})} onOpenPage={() => undefined} />);
    const run = screen.getByRole('region', { name: 'Run now' });
    await userEvent.click(within(run).getByRole('button', { name: 'Sync' }));
    expect(a.calls).toContainEqual({
      channel: 'brain:run',
      args: ['b1', 'sync'],
    });
    expect(a.tracked).toContainEqual(
      expect.objectContaining({ props: { action: 'sync' } }),
    );
    await userEvent.hover(
      within(run).getByRole('button', { name: 'Help: Sync' }),
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Compares what changed in the sources and the wiki since the last sync and updates the pages that cite it. Use it after editing pages by hand or after a large wiki refresh. Uses tokens and takes a few minutes.',
    );
    expect(a.tracked).toContainEqual(
      expect.objectContaining({ props: { action: 'help' } }),
    );
  });

  it('Run now: Open terminal hands the terminal to the caller', async () => {
    installFakeApi({ 'brain:terminal': () => def });
    const onTerminal = vi.fn();
    render(
      <BrainAdd
        brain={withOptions({})}
        onTerminal={onTerminal}
        onOpenPage={() => undefined}
      />,
    );
    const run = screen.getByRole('region', { name: 'Run now' });
    await userEvent.click(
      within(run).getByRole('button', { name: 'Open terminal' }),
    );
    await waitFor(() => expect(onTerminal).toHaveBeenCalledWith(def));
  });
});
