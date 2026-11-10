import {
  cleanup,
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
import { BrainAdd as BrainAddView } from './BrainAdd';

vi.mock('../../review/loadMonaco', () => ({
  loadMonaco: () => new Promise<never>(() => undefined),
}));
import { BrainHealth } from './BrainHealth';
import { useBrainPages } from './BrainWiki';

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
  pictures: [],
});

/** BrainAdd with its pages loaded the way the Brain screen loads them. */
function BrainAdd(
  props: Omit<React.ComponentProps<typeof BrainAddView>, 'pages'>,
) {
  const pages = useBrainPages(props.brain.id);
  return <BrainAddView {...props} pages={pages} />;
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    notices: [],
    screen: { kind: 'brain', brainId: 'b1' },
    brainPending: {},
    brainDrafts: {},
  });
});

describe('BrainAdd', () => {
  it('files dropped anywhere on the view become chips in the composer', async () => {
    installFakeApi({});
    const { container } = render(
      <BrainAdd brain={brainView()} onOpenPage={() => undefined} />,
    );
    const view = container.querySelector('.brain-add')!;
    fireEvent.dragOver(view, {
      dataTransfer: { types: ['Files'], items: [{}, {}] },
    });
    expect(screen.getByText('Drop to add 2 files')).toBeInTheDocument();
    fireEvent.drop(view, {
      dataTransfer: {
        types: ['Files'],
        files: [file('plan.pptx'), file('sow.docx')],
      },
    });
    expect(
      await screen.findByRole('group', { name: 'plan.pptx' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'sow.docx' })).toBeInTheDocument();
    expect(screen.queryByText('Drop to add 2 files')).toBeNull();
  });

  it('after an add the composer folds to one line; typing there opens it with the text kept', async () => {
    installFakeApi({
      'brain:addText': () => ({
        ok: true,
        path: 'sources/t.md',
        images: 0,
        dropped: 0,
        warnings: [],
        contents: '',
      }),
    });
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Text' }), {
      target: { value: '# Kick-off' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add text' }));
    expect(
      await screen.findByText(/Added Kick-off\. Capturing now/),
    ).toBeInTheDocument();
    const folded = screen.getByRole('textbox', { name: 'Write or paste' });
    fireEvent.change(folded, { target: { value: 'n' } });
    expect(screen.getByRole('textbox', { name: 'Text' })).toHaveValue('n');
  });

  it('lists Activity and keeps the side panel', async () => {
    installFakeApi({ 'brain:sources': () => [source('sources/a.md')] });
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    expect(
      await screen.findByRole('list', { name: 'Needs you' }),
    ).toHaveTextContent('a.md');
    expect(
      screen.getByRole('region', { name: 'What runs by itself' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Run now' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Health' })).toBeInTheDocument();
  });

  it('How it works sits behind the ? and is not a card', async () => {
    installFakeApi({});
    render(<BrainAdd brain={brainView()} onOpenPage={() => undefined} />);
    expect(screen.queryByRole('region', { name: 'How it works' })).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'How adding works' }),
    );
    const steps = screen.getByRole('list', { name: 'How adding works' });
    expect(steps).toHaveTextContent('1 · You add');
    expect(steps).toHaveTextContent(
      'The agent reads the source and writes or updates wiki pages.',
    );
    expect(steps).toHaveTextContent('4 · Read');
  });

  it('the deep link to adding files puts the cursor on Attach files', () => {
    installFakeApi({});
    render(
      <BrainAdd brain={brainView()} onOpenPage={() => undefined} focusChoose />,
    );
    expect(document.activeElement).toHaveTextContent('Attach files');
  });

  it('names no agent', async () => {
    installFakeApi({ 'brain:sources': () => [source('sources/a.md')] });
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
    await screen.findByRole('list', { name: 'Needs you' });
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

  it('Health says when the queue waits for Update skills', () => {
    installFakeApi({});
    const brain = brainView();
    render(<BrainHealth brain={brain} />);
    expect(screen.queryByText('held')).not.toBeInTheDocument();
    cleanup();
    brain.health = {
      ...brain.health!,
      queueHeld: 'Update skills to run on OpenCode',
    };
    render(<BrainHealth brain={brain} />);
    expect(screen.getByRole('region', { name: 'Health' })).toHaveTextContent(
      'held Update skills to run on OpenCode: Settings › Project › Brains › Update skills.',
    );
  });

  it('Health: the Pictures fact, and a picture finding offers Re-evaluate or Open source', async () => {
    const a = installFakeApi({
      'brain:run': (brainId, kind, src) =>
        brainJob({ brainId, kind, source: src ?? null, status: 'queued' }),
    });
    const onOpenPage = vi.fn();
    const brain = withOptions({});
    brain.health = {
      ...brain.health!,
      pictures: {
        total: 214,
        described: 200,
        skipped: 11,
        missing: 1,
        dropped: 2,
        accepted: 0,
        tiny: 23,
      },
      findings: [
        {
          kind: 'picture',
          page: 'sources/2026-11-04-acme-kickoff.md',
          detail: '1 picture not interpreted · 2 never reached the agent',
          code: 'pictures-dropped',
          at: '2026-11-07T09:00:00.000Z',
        },
        {
          kind: 'picture',
          page: 'sources/2026-10-28-network.md',
          detail: '4 never reached the agent',
          code: 'pictures-dropped',
          at: '2026-11-07T09:00:00.000Z',
        },
      ],
    };
    brain.health.pictures.accepted = 1;
    render(<BrainAdd brain={brain} onOpenPage={onOpenPage} />);
    const health = screen.getByRole('region', { name: 'Health' });
    expect(health).toHaveTextContent(
      'Pictures211 of 214 interpreted · 1 not interpreted · 2 never reached the agent · 1 accepted',
    );
    // A source with both gaps offers both; no picture finding goes to the terminal.
    expect(
      within(health).getByRole('button', {
        name: 'Open source sources/2026-11-04-acme-kickoff.md',
      }),
    ).toBeInTheDocument();
    expect(
      within(health).queryByRole('button', {
        name: /Resolve in terminal: picture/,
      }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(health).getByRole('button', {
        name: 'Re-evaluate sources/2026-11-04-acme-kickoff.md',
      }),
    );
    expect(
      a.calls.filter((c) => c.channel === 'brain:run').map((c) => c.args),
    ).toEqual([['b1', 'pictures', 'sources/2026-11-04-acme-kickoff.md']]);
    expect(a.tracked).toContainEqual(
      expect.objectContaining({ props: { action: 'reevaluate' } }),
    );
    await userEvent.click(
      within(health).getByRole('button', {
        name: 'Open source sources/2026-10-28-network.md',
      }),
    );
    expect(onOpenPage).toHaveBeenCalledWith('sources/2026-10-28-network.md');
  });

  it('Health: Re-evaluate says Re-evaluating… while a pictures job for the source is coming', () => {
    installFakeApi({});
    const page = 'sources/2026-11-04-acme-kickoff.md';
    const brain = withOptions({});
    brain.health = {
      ...brain.health!,
      findings: [
        {
          kind: 'picture',
          page,
          detail: '1 picture not interpreted',
          at: '2026-11-07T09:00:00.000Z',
        },
      ],
    };
    const { rerender } = render(<BrainHealth brain={brain} />);
    expect(
      screen.getByRole('button', { name: `Re-evaluate ${page}` }),
    ).toBeEnabled();
    for (const status of ['queued', 'running', 'paused'] as const) {
      rerender(
        <BrainHealth
          brain={{
            ...brain,
            jobs: [
              brainJob({ kind: 'pictures', source: page, status }),
              brainJob({ kind: 'capture', source: page, status: 'running' }),
            ],
          }}
        />,
      );
      const button = screen.getByRole('button', {
        name: `Re-evaluating ${page}`,
      });
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('Re-evaluating…');
    }
    rerender(
      <BrainHealth
        brain={{
          ...brain,
          jobs: [brainJob({ kind: 'pictures', source: page, status: 'done' })],
        }}
      />,
    );
    expect(
      screen.getByRole('button', { name: `Re-evaluate ${page}` }),
    ).toBeEnabled();
  });

  it('Health on a brain whose skills are older than v6: a note to update them instead of Re-evaluate', () => {
    installFakeApi({});
    const page = 'sources/2026-11-04-acme-kickoff.md';
    const brain = { ...withOptions({}), templatesVersion: 5 };
    brain.health = {
      ...brain.health!,
      findings: [
        {
          kind: 'picture',
          page,
          detail: '1 picture not interpreted',
          at: '2026-11-07T09:00:00.000Z',
        },
      ],
    };
    render(<BrainHealth brain={brain} />);
    const finding = screen.getByText(page).closest('li') as HTMLElement;
    expect(within(finding).queryAllByRole('button')).toEqual([]);
    expect(
      within(finding).getByText('Update skills to re-evaluate'),
    ).toHaveClass('muted');
  });

  it('Health without onOpen: a drop-only picture finding has no button', () => {
    installFakeApi({});
    const brain = withOptions({});
    brain.health = {
      ...brain.health!,
      findings: [
        {
          kind: 'picture',
          page: 'sources/2026-10-28-network.md',
          detail: '4 never reached the agent',
          code: 'pictures-dropped',
          at: '2026-11-07T09:00:00.000Z',
        },
      ],
    };
    render(<BrainHealth brain={brain} />);
    const finding = screen
      .getByText('sources/2026-10-28-network.md')
      .closest('li') as HTMLElement;
    expect(within(finding).queryAllByRole('button')).toEqual([]);
  });

  it('Health: Open source follows the finding code, not its words', () => {
    installFakeApi({});
    const brain = withOptions({});
    brain.health = {
      ...brain.health!,
      findings: [
        {
          kind: 'picture',
          page: 'sources/a.md',
          detail: 'worded otherwise',
          code: 'pictures-dropped',
          at: '2026-11-07T09:00:00.000Z',
        },
        {
          kind: 'picture',
          page: 'sources/b.md',
          detail: '4 never reached the agent',
          at: '2026-11-07T09:00:00.000Z',
        },
      ],
    };
    render(<BrainHealth brain={brain} onOpen={() => undefined} />);
    expect(
      screen.getByRole('button', { name: 'Open source sources/a.md' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open source sources/b.md' }),
    ).not.toBeInTheDocument();
  });

  it('Health: no Pictures fact without pictures; only the parts that are not zero', () => {
    installFakeApi({});
    const brain = withOptions({});
    const { rerender } = render(
      <BrainAdd brain={brain} onOpenPage={() => undefined} />,
    );
    const health = screen.getByRole('region', { name: 'Health' });
    expect(health).not.toHaveTextContent('Pictures');
    rerender(
      <BrainAdd
        brain={{
          ...brain,
          health: {
            ...brain.health!,
            pictures: { ...brain.health!.pictures, total: 5, described: 5 },
          },
        }}
        onOpenPage={() => undefined}
      />,
    );
    expect(health).toHaveTextContent(/Pictures5 of 5 interpretedWiki mirror/);
  });

  it('the picture check for earlier sources shows its progress while it runs, and is gone when done', () => {
    installFakeApi({});
    const pass = {
      startedAt: '2026-11-07T08:00:00.000Z',
      total: 23,
      sources: [],
      done: ['sources/a.md', 'sources/b.md', 'sources/c.md'],
      failures: {},
      finishedAt: null,
    };
    const { rerender } = render(
      <BrainAdd
        brain={{ ...withOptions({}), picturePass: pass }}
        onOpenPage={() => undefined}
      />,
    );
    const card = screen.getByRole('region', { name: 'What runs by itself' });
    expect(card).toHaveTextContent(
      'Picture check for earlier sourcesrunning23 sources captured before Shellie checked pictures. Re-evaluating them in the background, 3 of 23 done.',
    );
    rerender(
      <BrainAdd
        brain={{
          ...withOptions({}),
          picturePass: { ...pass, finishedAt: '2026-11-08T08:00:00.000Z' },
        }}
        onOpenPage={() => undefined}
      />,
    );
    expect(card).not.toHaveTextContent('Picture check');
  });

  it('the first arrangement of the book is listed for a brain on skills v8 only', () => {
    installFakeApi({});
    const { rerender } = render(
      <BrainAdd
        brain={{ ...withOptions({}), templatesVersion: 8 }}
        onOpenPage={() => undefined}
      />,
    );
    const card = screen.getByRole('region', { name: 'What runs by itself' });
    expect(card).toHaveTextContent(
      'Arrange the brain as a bookautoonce, in the background, when a brain has pages and no book yet',
    );
    rerender(
      <BrainAdd
        brain={{ ...withOptions({}), templatesVersion: 7 }}
        onOpenPage={() => undefined}
      />,
    );
    expect(card).not.toHaveTextContent('Arrange the brain as a book');
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
