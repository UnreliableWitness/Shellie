import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDoc, TaskView } from '../../../shared/types';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { DocsTab, resetDocTargetsForTests } from './DocsTab';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg/>' })),
  },
}));

const task = {
  id: 't1',
  status: 'ready',
  terminals: [],
  worktreeMissing: false,
  extraWorkspaces: [],
  homeDropped: false,
} as unknown as TaskView;
const files = [
  { path: '.shellie/task.md', changed: null },
  { path: 'README.md', changed: null },
  { path: 'docs/plan.md', changed: 'new' as const },
];
let texts: Record<string, string>;
/** These tests cover the All docs list; the session view has its own below. */
const allDocs = () => localStorage.setItem('shellie.docs.mode.t1', 'all');
beforeEach(() => {
  localStorage.clear();
  allDocs();
  resetDocTargetsForTests();
  texts = {
    '.shellie/task.md': '# Task file',
    'README.md': '# Readme',
    'docs/plan.md': '# Plan\n\nline 3\n',
  };
  useStore.setState({ docTarget: {} });
});
const mount = (over = {}) => {
  const api = installFakeApi({
    'docs:list': () => ({ files }),
    'docs:read': (_t, p) => {
      if (!(p in texts)) throw new Error('Not found');
      return { text: texts[p], mtimeMs: 1 };
    },
    'docs:openInEditor': () => undefined,
    'docs:reveal': () => undefined,
    ...over,
  });
  const view = render(<DocsTab task={task} />);
  return Object.assign(api, { view });
};

describe('DocsTab', () => {
  it('opens the task file by default and lists files grouped with badges', async () => {
    mount();
    expect(
      await screen.findByRole('heading', { name: 'Task file' }),
    ).toBeTruthy();
    expect(screen.getByText('docs')).toBeTruthy();
    expect(screen.getByText('new')).toBeTruthy();
  });
  it('shows the empty state', async () => {
    mount({ 'docs:list': () => ({ files: [] }) });
    expect(
      await screen.findByText('No Markdown files in this worktree'),
    ).toBeTruthy();
  });
  it('filters the list', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Task file' });
    await userEvent.type(screen.getByPlaceholderText('Filter'), 'plan');
    expect(screen.queryByRole('button', { name: /README\.md/ })).toBeNull();
    expect(screen.getByRole('button', { name: /plan\.md/ })).toBeTruthy();
  });
  it('switches to Source and remembers file and view', async () => {
    mount();
    await userEvent.click(
      await screen.findByRole('button', { name: /plan\.md/ }),
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect(document.querySelectorAll('.src-line')).toHaveLength(3);
    expect(
      JSON.parse(localStorage.getItem('shellie.docs.t1') ?? '{}'),
    ).toMatchObject({ path: 'docs/plan.md', view: 'source' });
  });
  it('reloads on docs:changed and shows the deleted bar when the file goes', async () => {
    const api = mount();
    await screen.findByRole('heading', { name: 'Task file' });
    texts['.shellie/task.md'] = '# Task file v2';
    act(() =>
      api.emit('docs:changed', { taskId: 't1', paths: ['.shellie/task.md'] }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Task file v2' }),
    ).toBeTruthy();
    delete texts['.shellie/task.md'];
    act(() =>
      api.emit('docs:changed', { taskId: 't1', paths: ['.shellie/task.md'] }),
    );
    expect(await screen.findByText('This file was deleted.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Task file v2' })).toBeTruthy();
  });
  it('shows the too-large state with Open in VS Code', async () => {
    mount({
      'docs:read': () => {
        throw new Error('Too large');
      },
    });
    expect(
      await screen.findByText('This file is larger than 2 MB.'),
    ).toBeTruthy();
  });
  it('opens a target set by openDoc in Source view at its line', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Task file' });
    act(() =>
      useStore.setState({
        docTarget: { t1: { path: 'docs/plan.md', line: 3, nonce: 1 } },
      }),
    );
    await waitFor(() =>
      expect(
        document.querySelector('.src-line.is-hl')?.getAttribute('data-line'),
      ).toBe('3'),
    );
  });
  it('opens VS Code at the highlighted line', async () => {
    const api = mount();
    act(() =>
      useStore.setState({
        docTarget: { t1: { path: 'docs/plan.md', line: 3, nonce: 2 } },
      }),
    );
    await waitFor(() =>
      expect(document.querySelector('.src-line.is-hl')).not.toBeNull(),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Open in VS Code' }),
    );
    expect(
      api.calls.find((c) => c.channel === 'docs:openInEditor')?.args,
    ).toEqual(['t1', 'docs/plan.md', 3]);
  });
  it('pairs docs:watch on with off on unmount', async () => {
    const api = mount();
    await screen.findByRole('heading', { name: 'Task file' });
    api.view.unmount();
    const w = api.calls
      .filter((c) => c.channel === 'docs:watch')
      .map((c) => c.args[1]);
    expect(w.filter(Boolean).length).toBe(w.filter((x) => !x).length);
  });
  it('polls docs:read when the watcher is not live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let mtime = 1;
      mount({
        'docs:watch': () => ({ live: false }),
        'docs:read': () => ({
          text: texts['.shellie/task.md'],
          mtimeMs: mtime,
        }),
      });
      await screen.findByRole('heading', { name: 'Task file' });
      texts['.shellie/task.md'] = '# Polled';
      mtime = 2;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(
        await screen.findByRole('heading', { name: 'Polled' }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not send docs:watch off when on was rejected', async () => {
    const api = mount({
      'docs:watch': () => {
        throw new Error('nope');
      },
    });
    await screen.findByRole('heading', { name: 'Task file' });
    api.view.unmount();
    await Promise.resolve();
    const w = api.calls.filter((c) => c.channel === 'docs:watch');
    expect(w.map((c) => c.args[1])).toEqual([true]);
  });
  it('never shows a polled file of the old path after switching files', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let release: () => void = () => undefined;
      let mode: 'normal' | 'held' | 'stale' = 'normal';
      mount({
        'docs:watch': () => ({ live: false }),
        'docs:read': async (_t: string, p: string) => {
          if (p === '.shellie/task.md' && mode !== 'normal') {
            if (mode === 'held') await new Promise<void>((r) => (release = r));
            return { text: '# OLD STALE', mtimeMs: 9 };
          }
          return { text: texts[p], mtimeMs: 1 };
        },
      });
      await screen.findByRole('heading', { name: 'Task file' });
      mode = 'held';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      await userEvent.click(screen.getByRole('button', { name: /README\.md/ }));
      expect(
        await screen.findByRole('heading', { name: 'Readme' }),
      ).toBeTruthy();
      await act(async () => {
        mode = 'stale';
        release();
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.queryByText('OLD STALE')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Readme' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
  it('reopens the remembered file and view after a remount', async () => {
    const first = mount();
    await userEvent.click(
      await screen.findByRole('button', { name: /plan\.md/ }),
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect(document.querySelectorAll('.src-line')).toHaveLength(3);
    first.view.unmount();
    mount();
    await waitFor(() =>
      expect(document.querySelectorAll('.src-line')).toHaveLength(3),
    );
    expect(screen.queryByRole('heading', { name: 'Task file' })).toBeNull();
  });

  it('keeps passing the target line to VS Code after the highlight fades', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = mount();
      act(() =>
        useStore.setState({
          docTarget: { t1: { path: 'docs/plan.md', line: 3, nonce: 3 } },
        }),
      );
      await waitFor(() =>
        expect(document.querySelector('.src-line.is-hl')).not.toBeNull(),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(document.querySelector('.src-line.is-hl')).toBeNull();
      await userEvent.click(
        screen.getByRole('button', { name: 'Open in VS Code' }),
      );
      expect(
        api.calls.find((c) => c.channel === 'docs:openInEditor')?.args,
      ).toEqual(['t1', 'docs/plan.md', 3]);
      // Another file has no target line.
      await userEvent.click(screen.getByRole('button', { name: /README\.md/ }));
      await screen.findByText('# Readme');
      await userEvent.click(
        screen.getByRole('button', { name: 'Open in VS Code' }),
      );
      expect(
        api.calls.filter((c) => c.channel === 'docs:openInEditor').at(-1)?.args,
      ).toEqual(['t1', 'README.md', undefined]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('starts the highlight timer once the text has rendered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let release: () => void = () => undefined;
      mount({
        'docs:read': async (_t: string, p: string) => {
          if (p === 'docs/plan.md')
            await new Promise<void>((r) => (release = r));
          return { text: texts[p], mtimeMs: 1 };
        },
      });
      await screen.findByRole('heading', { name: 'Task file' });
      act(() =>
        useStore.setState({
          docTarget: { t1: { path: 'docs/plan.md', line: 3, nonce: 4 } },
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        release();
        await vi.advanceTimersByTimeAsync(10);
      });
      await waitFor(() =>
        expect(
          document.querySelector('.src-line.is-hl')?.getAttribute('data-line'),
        ).toBe('3'),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('reloads the list only for Markdown or extensionless paths', async () => {
    const api = mount();
    await screen.findByRole('heading', { name: 'Task file' });
    const lists = () =>
      api.calls.filter((c) => c.channel === 'docs:list').length;
    const before = lists();
    act(() =>
      api.emit('docs:changed', {
        taskId: 't1',
        paths: ['src/a.ts', 'dist/b.js', 'x.json'],
      }),
    );
    await Promise.resolve();
    expect(lists()).toBe(before);
    act(() => api.emit('docs:changed', { taskId: 't1', paths: ['docs/c.MD'] }));
    await waitFor(() => expect(lists()).toBe(before + 1));
    act(() => api.emit('docs:changed', { taskId: 't1', paths: ['docs/new'] }));
    await waitFor(() => expect(lists()).toBe(before + 2));
  });
  it('coalesces list reloads while one is in flight', async () => {
    let held: (() => void)[] = [];
    const api = mount({
      'docs:list': async () => {
        await new Promise<void>((r) => held.push(r));
        return { files };
      },
    });
    await waitFor(() => expect(held).toHaveLength(1));
    const releaseAll = () => {
      const h = held;
      held = [];
      for (const r of h) r();
    };
    for (let i = 0; i < 5; i++)
      act(() => api.emit('docs:changed', { taskId: 't1', paths: ['a.md'] }));
    await act(async () => releaseAll());
    await waitFor(() => expect(held).toHaveLength(1));
    await act(async () => releaseAll());
    await screen.findByRole('heading', { name: 'Task file' });
    expect(api.calls.filter((c) => c.channel === 'docs:list')).toHaveLength(2);
  });

  it('falls back to polling when main stops the watcher', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let mtime = 1;
      const api = mount({
        'docs:read': () => ({
          text: texts['.shellie/task.md'],
          mtimeMs: mtime,
        }),
      });
      await screen.findByRole('heading', { name: 'Task file' });
      act(() => api.emit('docs:watchStopped', { taskId: 't1' }));
      texts['.shellie/task.md'] = '# Polled after stop';
      mtime = 2;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(
        await screen.findByRole('heading', { name: 'Polled after stop' }),
      ).toBeTruthy();
      api.view.unmount();
      await act(async () => {});
      expect(
        api.calls
          .filter((c) => c.channel === 'docs:watch')
          .map((c) => c.args[1]),
      ).toEqual([true]);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe('DocsTab with several repos', () => {
  const multi = {
    ...task,
    repoId: 'r1',
    branch: 'b1',
    extraWorkspaces: [{ id: 'w2', repoId: 'r2', branch: 'b2', dropped: false }],
  } as unknown as TaskView;
  const seed = () => {
    useStore.setState({
      repos: [
        { id: 'r1', name: 'alpha' },
        { id: 'r2', name: 'beta' },
      ] as never,
    });
  };
  it('has no repo switcher with one workspace', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Task file' });
    expect(screen.queryByRole('combobox', { name: 'Repository' })).toBeNull();
  });
  it('switches repo and lists that repo files', async () => {
    seed();
    const lists: string[] = [];
    installFakeApi({
      'docs:list': (t) => {
        lists.push(t as string);
        return {
          files:
            t === 't1#w2'
              ? [{ path: 'beta.md', changed: null }]
              : [{ path: 'alpha.md', changed: null }],
        };
      },
      'docs:read': (_t, p) => ({ text: `# ${p}`, mtimeMs: 1 }),
    });
    render(<DocsTab task={multi} />);
    await screen.findByRole('heading', { name: 'alpha.md' });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Repository' }),
      'w2',
    );
    expect(
      await screen.findByRole('heading', { name: 'beta.md' }),
    ).toBeTruthy();
    expect(lists).toEqual(['t1', 't1#w2']);
  });
  const multiApi = () =>
    installFakeApi({
      'docs:list': (t) => ({
        files:
          t === 't1#w2'
            ? [
                { path: 'beta.md', changed: null },
                { path: 'x.md', changed: null },
              ]
            : [{ path: 'alpha.md', changed: null }],
      }),
      'docs:read': (_t, p) => ({ text: `# ${p}\n\nl2\n`, mtimeMs: 1 }),
    });
  it('opens a terminal link in the linked workspace at its line', async () => {
    seed();
    multiApi();
    useStore.getState().openDoc('t1', 'x.md', 3, 'w2');
    render(<DocsTab task={multi} />);
    expect(await screen.findByText('# x.md')).toBeTruthy();
    expect(
      (
        screen.getByRole('combobox', {
          name: 'Repository',
        }) as HTMLSelectElement
      ).value,
    ).toBe('w2');
    expect(
      JSON.parse(localStorage.getItem('shellie.docs.t1#w2') ?? '{}'),
    ).toMatchObject({
      path: 'x.md',
      view: 'source',
    });
  });
  it('does not replay an old terminal link when the tab remounts', async () => {
    seed();
    multiApi();
    useStore.getState().openDoc('t1', 'x.md', 3, 'w2');
    const first = render(<DocsTab task={multi} />);
    await screen.findByText('# x.md');
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Repository' }),
      'w2',
    );
    first.unmount();
    localStorage.clear();
    allDocs();
    render(<DocsTab task={multi} />);
    await screen.findByRole('heading', { name: 'alpha.md' });
    expect(
      (
        screen.getByRole('combobox', {
          name: 'Repository',
        }) as HTMLSelectElement
      ).value,
    ).toBe('home');
  });
});

describe('DocsTab session view', () => {
  const multi = {
    ...task,
    repoId: 'r1',
    branch: 'b1',
    extraWorkspaces: [{ id: 'w2', repoId: 'r2', branch: 'b2', dropped: false }],
  } as unknown as TaskView;
  const OUT = 'C:/Projects/investigations/push-order.md';
  const session: SessionDoc[] = [
    {
      path: 'docs/plan.md',
      workspaceId: 'home',
      changed: 'new',
      claude: true,
      mtimeMs: 1,
    },
    {
      path: 'api.md',
      workspaceId: 'w2',
      changed: null,
      claude: true,
      mtimeMs: 1,
    },
    { path: OUT, workspaceId: null, changed: null, claude: true, mtimeMs: 1 },
  ];
  let reads: string[];
  const start = (over = {}, t: TaskView = multi) => {
    localStorage.removeItem('shellie.docs.mode.t1');
    useStore.setState({
      repos: [
        { id: 'r1', name: 'alpha' },
        { id: 'r2', name: 'beta' },
      ] as never,
    });
    reads = [];
    const api = installFakeApi({
      'docs:list': () => ({ files }),
      'docs:session': () => ({ files: session }),
      'docs:read': (_t, p) => {
        reads.push(p as string);
        return { text: `# ${p}`, mtimeMs: 1 };
      },
      ...over,
    });
    render(<DocsTab task={t} />);
    return api;
  };
  const fileButtons = () =>
    [...document.querySelectorAll('.docs-list .docs-file')].map(
      (b) => b.textContent,
    );

  it('shows only session docs, as a tree under repo names and outside folders', async () => {
    start();
    expect(
      await screen.findByRole('heading', { name: 'docs/plan.md' }),
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveProperty(
      'ariaSelected',
      'true',
    );
    const folders = [
      ...document.querySelectorAll('.docs-list .docs-tree-folder'),
    ].map((b) => b.textContent);
    expect(folders).toEqual([
      'alpha',
      'docs',
      'beta',
      'C:/Projects/investigations',
    ]);
    expect(fileButtons()).toEqual(['plan.mdnew', 'api.md', 'push-order.md']);
    expect(screen.queryByRole('button', { name: /README\.md/ })).toBeNull();
  });

  it('opens a doc outside the worktree by its absolute path', async () => {
    start();
    await screen.findByRole('heading', { name: 'docs/plan.md' });
    await userEvent.click(
      screen.getByRole('button', { name: /push-order\.md/ }),
    );
    expect(await screen.findByRole('heading', { name: `${OUT}` })).toBeTruthy();
    expect(reads).toContain(OUT);
  });

  it('opens another repo session doc in that repo', async () => {
    start();
    await screen.findByRole('heading', { name: 'docs/plan.md' });
    await userEvent.click(screen.getByRole('button', { name: /api\.md/ }));
    expect(await screen.findByRole('heading', { name: 'api.md' })).toBeTruthy();
    expect(
      (
        screen.getByRole('combobox', {
          name: 'Repository',
        }) as HTMLSelectElement
      ).value,
    ).toBe('w2');
  });

  it('folds a folder', async () => {
    start();
    await screen.findByRole('heading', { name: 'docs/plan.md' });
    await userEvent.click(screen.getByRole('button', { name: 'alpha' }));
    expect(fileButtons()).toEqual(['api.md', 'push-order.md']);
    expect(
      screen
        .getByRole('button', { name: 'alpha' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('switches to All docs and back, and remembers the choice', async () => {
    const api = start();
    await screen.findByRole('heading', { name: 'docs/plan.md' });
    await userEvent.click(screen.getByRole('tab', { name: 'All docs' }));
    expect(
      await screen.findByRole('button', { name: /README\.md/ }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Task/ })).toBeTruthy();
    expect(localStorage.getItem('shellie.docs.mode.t1')).toBe('all');
    expect(api.calls.some((c) => c.channel === 'docs:list')).toBe(true);
    await userEvent.click(screen.getByRole('tab', { name: 'Session' }));
    expect(
      await screen.findByRole('button', { name: /push-order\.md/ }),
    ).toBeTruthy();
  });

  it('explains the empty session view', async () => {
    start({ 'docs:session': () => ({ files: [] }) });
    expect(
      await screen.findByText(
        'No session docs yet. Markdown files Claude edits or creates in this task show up here.',
      ),
    ).toBeTruthy();
  });

  it('opens a terminal link to an outside doc', async () => {
    start();
    await screen.findByRole('heading', { name: 'docs/plan.md' });
    act(() => useStore.getState().openDoc('t1', OUT));
    expect(await screen.findByRole('heading', { name: OUT })).toBeTruthy();
  });

  it('polls the session list and reloads an open outside doc that changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let mtime = 1;
      let text = '# v1';
      start({
        'docs:session': () => ({
          files: session.map((d) =>
            d.path === OUT ? { ...d, mtimeMs: mtime } : d,
          ),
        }),
        'docs:read': (_t: string, p: string) => ({
          text: p === OUT ? text : `# ${p}`,
          mtimeMs: mtime,
        }),
      });
      await screen.findByRole('heading', { name: 'docs/plan.md' });
      await userEvent.click(
        screen.getByRole('button', { name: /push-order\.md/ }),
      );
      await screen.findByRole('heading', { name: 'v1' });
      mtime = 2;
      text = '# v2';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(await screen.findByRole('heading', { name: 'v2' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
