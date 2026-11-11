import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskView } from '../shared/types';
import {
  activeConnection,
  CHANGES_TAB,
  type Screen,
  USAGE_TAB,
  useStore,
} from './store';
import { installFakeApi } from './test-helpers/fakeApi';

const base = useStore.getState();
const task = (id: string, terms: string[]): TaskView => ({
  id,
  repoId: 'r',
  name: id,
  workItem: null,
  slug: id,
  branch: 'b',
  worktreePath: '/w',
  baseRef: 'main',
  baseSha: null,
  openPeriods: [],
  time: null,
  status: 'ready',
  setup: {
    copy: false,
    commands: [],
    startClaude: false,
    openShell: false,
    openCopilot: false,
    summary: null,
  },
  terminals: terms.map((t) => ({ id: t, kind: 'shell' as const, label: t })),
  createdAt: 'now',
  finishedAt: null,
  worktreeMissing: false,
  usageSyncedAt: null,
  usageSyncError: null,
  usageCommentId: null,
  summary: null,
  pullRequest: null,
  closedTerminals: [],
  reopen: null,
  extraWorkspaces: [],
  detachedPaths: [],
  homeDropped: false,
  connectionId: null,
  mainCheckoutEdits: [],
  environment: 'development',
  environmentUntil: null,
  pendingCleanup: [],
});

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    ...base,
    tasks: [],
    tabByTask: {},
    viewsByTask: {},
    focus: false,
    navCollapsed: false,
    screen: { kind: 'sprint' },
    previous: null,
    selectedTaskId: null,
  });
});

describe('discard (#124)', () => {
  it('askDiscard opens the task page with its question; leaving the page or the task drops it', () => {
    useStore.setState({ tasks: [task('a', []), task('b', [])] });
    const s = () => useStore.getState();
    s().askDiscard('a');
    expect(s().selectedTaskId).toBe('a');
    expect(s().screen).toEqual({ kind: 'task' });
    expect(s().discardTaskId).toBe('a');
    s().select('b');
    expect(s().discardTaskId).toBeNull();
    s().askDiscard('a');
    s().go({ kind: 'home' });
    expect(s().discardTaskId).toBeNull();
    s().askDiscard('a');
    s().cancelDiscard();
    expect(s().discardTaskId).toBeNull();
  });
});

describe('tabs', () => {
  it('defaults to the first terminal, or Usage without terminals', () => {
    useStore.setState({ tasks: [task('a', ['t1', 't2']), task('b', [])] });
    expect(useStore.getState().activeTab('a')).toBe('t1');
    expect(useStore.getState().activeTab('b')).toBe(USAGE_TAB);
  });
  it('falls back when the selected terminal is gone', () => {
    useStore.setState({ tasks: [task('a', ['t1', 't2'])] });
    useStore.getState().setTab('a', 't2');
    useStore.setState({ tasks: [task('a', ['t1'])] });
    expect(useStore.getState().activeTab('a')).toBe('t1');
    useStore.setState({ tasks: [task('a', [])] });
    expect(useStore.getState().activeTab('a')).toBe(USAGE_TAB);
  });
  it('openUsage selects the task, its page and the Usage tab', () => {
    useStore.setState({
      tasks: [task('a', ['t1'])],
      screen: { kind: 'settings' },
    });
    useStore.getState().openUsage('a');
    const s = useStore.getState();
    expect(s.selectedTaskId).toBe('a');
    expect(s.screen).toEqual({ kind: 'task' });
    expect(s.activeTab('a')).toBe(USAGE_TAB);
  });
  it('openDoc selects the task, opens the Docs tab and sets a fresh target', () => {
    useStore.setState({ tasks: [task('t1', ['x'])] });
    useStore.getState().openDoc('t1', 'a.md', 4);
    const s = useStore.getState();
    expect(s.selectedTaskId).toBe('t1');
    expect(s.screen.kind).toBe('task');
    expect(s.activeTab('t1')).toBe('docs');
    const first = s.docTarget.t1.nonce;
    s.openDoc('t1', 'a.md', 4);
    expect(useStore.getState().docTarget.t1.nonce).not.toBe(first);
  });

  it('openView opens an HTML file in a tab, and the same file again refocuses it', () => {
    useStore.setState({
      tasks: [task('t1', ['x'])],
      screen: { kind: 'home' },
    });
    const s = useStore.getState();
    s.openView('t1', 'C:/Users/me/.claude/reviews/pr-759/index.html');
    const [v] = useStore.getState().viewsByTask.t1;
    expect(v).toMatchObject({
      path: 'C:/Users/me/.claude/reviews/pr-759/index.html',
      name: 'index.html',
    });
    expect(v.id.startsWith('view:')).toBe(true);
    expect(useStore.getState().screen).toEqual({ kind: 'task' });
    expect(useStore.getState().selectedTaskId).toBe('t1');
    expect(s.activeTab('t1')).toBe(v.id);

    s.setTab('t1', 'x');
    s.openView('t1', 'report/a.html', 'w2');
    s.openView('t1', 'C:/Users/me/.claude/reviews/pr-759/index.html');
    expect(useStore.getState().viewsByTask.t1).toHaveLength(2);
    expect(s.activeTab('t1')).toBe(v.id);
    // The same path in another workspace is another file.
    s.openView('t1', 'report/a.html');
    expect(useStore.getState().viewsByTask.t1).toHaveLength(3);
  });
  it('closeView removes the tab; the active tab falls back to the first terminal', () => {
    useStore.setState({ tasks: [task('t1', ['x', 'y']), task('t2', [])] });
    const s = useStore.getState();
    s.openView('t1', 'a.html');
    s.openView('t1', 'b.html');
    const [a, b] = useStore.getState().viewsByTask.t1;
    s.closeView('t1', a.id);
    expect(useStore.getState().viewsByTask.t1).toEqual([b]);
    expect(s.activeTab('t1')).toBe(b.id);
    s.closeView('t1', b.id);
    expect(s.activeTab('t1')).toBe('x');
    s.openView('t2', 'c.html');
    s.closeView('t2', useStore.getState().viewsByTask.t2[0].id);
    expect(s.activeTab('t2')).toBe(USAGE_TAB);
  });
  it('a view id of another task is not a valid tab', () => {
    useStore.setState({ tasks: [task('t1', ['x']), task('t2', ['z'])] });
    useStore.getState().openView('t1', 'a.html');
    const id = useStore.getState().viewsByTask.t1[0].id;
    useStore.getState().setTab('t2', id);
    expect(useStore.getState().activeTab('t2')).toBe('z');
  });

  it('keeps the Changes tab and opens it for a task', () => {
    useStore.setState({
      tasks: [{ id: 't1', terminals: [] } as never],
      tabByTask: {},
    });
    useStore.getState().openChanges('t1');
    expect(useStore.getState().selectedTaskId).toBe('t1');
    expect(useStore.getState().activeTab('t1')).toBe(CHANGES_TAB);
  });
});

describe('focus and rail', () => {
  it('persist through uiPrefs', () => {
    useStore.getState().toggleFocus();
    useStore.getState().setNavCollapsed(true);
    expect(useStore.getState().focus).toBe(true);
    expect(localStorage.getItem('shellie.ui.focus')).toBe('true');
    expect(localStorage.getItem('shellie.ui.navCollapsed')).toBe('true');
  });
});

describe('navigation', () => {
  it('starts on Sprint and does not auto-select a task', () => {
    expect(useStore.getState().screen).toEqual({ kind: 'sprint' });
    useStore.getState().setTasks([task('a', []), task('b', [])]);
    expect(useStore.getState().selectedTaskId).toBeNull();
  });
  it('keeps the selection while the task exists and drops it when it goes', () => {
    useStore.getState().setTasks([task('a', [])]);
    useStore.getState().select('a');
    useStore.getState().setTasks([task('a', []), task('b', [])]);
    expect(useStore.getState().selectedTaskId).toBe('a');
    useStore.getState().setTasks([task('b', [])]);
    expect(useStore.getState().selectedTaskId).toBeNull();
  });
  it('back returns to the page before New task or Finish', () => {
    useStore.setState({ tasks: [task('a', [])] });
    useStore.getState().openTask('a');
    useStore.getState().go({ kind: 'new-task' });
    useStore.getState().back();
    expect(useStore.getState().screen).toEqual({ kind: 'task' });
    useStore.getState().go({ kind: 'settings' });
    useStore.getState().go({ kind: 'finish', taskId: 'a' });
    useStore.getState().back();
    expect(useStore.getState().screen).toEqual({ kind: 'settings' });
  });
  it('back goes to Sprint when there is nothing to return to', () => {
    useStore.getState().go({ kind: 'new-task' });
    useStore.getState().back();
    expect(useStore.getState().screen).toEqual({ kind: 'sprint' });
  });
  it('openTask routes a task that is setting up to its setup page', () => {
    useStore.setState({ tasks: [{ ...task('a', []), status: 'setting-up' }] });
    useStore.getState().openTask('a');
    expect(useStore.getState().screen).toEqual({ kind: 'setup', taskId: 'a' });
    expect(useStore.getState().selectedTaskId).toBe('a');
  });
});

describe('unchanged objects stay the same (renders skip them)', () => {
  it('setTasks keeps a task that did not change and replaces one that did', () => {
    useStore.getState().setTasks([task('a', ['t1']), task('b', [])]);
    const [a, b] = useStore.getState().tasks;
    useStore
      .getState()
      .setTasks([task('a', ['t1']), { ...task('b', []), name: 'B' }]);
    const [a2, b2] = useStore.getState().tasks;
    expect(a2).toBe(a);
    expect(b2).not.toBe(b);
    expect(b2.name).toBe('B');
  });
  it('setTasks keeps the list itself when nothing changed', () => {
    useStore.getState().setTasks([task('a', [])]);
    const list = useStore.getState().tasks;
    useStore.getState().setTasks([task('a', [])]);
    expect(useStore.getState().tasks).toBe(list);
  });
  it('setAttention keeps an entry that did not change', () => {
    const entry = { reason: 'done' as const, since: 1 };
    useStore.getState().setAttention({ t1: entry, t2: { ...entry } });
    const before = useStore.getState().attention;
    useStore.getState().setAttention({
      t1: { ...entry },
      t2: { reason: 'blocked', since: 2 },
    });
    expect(useStore.getState().attention.t1).toBe(before.t1);
    expect(useStore.getState().attention.t2).toEqual({
      reason: 'blocked',
      since: 2,
    });
  });
});

describe('activeConnection', () => {
  const conn = (id: string) => ({
    id,
    name: `org-${id}`,
    organizationUrl: `https://dev.azure.com/org-${id}`,
    project: `P${id}`,
    user: null,
    status: 'ok' as const,
    checkedAt: null,
    userUniqueName: null,
    provider: 'azure-devops' as const,
    workItemOnStart: {
      moveToInProgress: true,
      assignToMe: true,
      stateOverrides: {},
    },
    writeTimeToAdo: false,
  });
  const repo = (id: string, connectionId: string | null) => ({
    id,
    name: id,
    path: `/${id}`,
    baseBranch: 'main',
    connectionId,
    configFound: true,
    discovered: false,
    overrides: {},
    workItemOnStart: {
      moveToInProgress: true,
      assignToMe: true,
      stateOverrides: {},
    },
  });
  it('prefers the switcher choice, then the selected task, then the first linked repo', () => {
    const s = {
      connections: [conn('1'), conn('2'), conn('3')],
      repos: [repo('r', null), repo('a', '2'), repo('b', '3')],
      tasks: [{ ...task('t', []), repoId: 'b' }],
      selectedTaskId: null as string | null,
      connectionId: null as string | null,
      screen: { kind: 'sprint' } as Screen,
    };
    expect(activeConnection(s)?.id).toBe('2');
    expect(activeConnection({ ...s, selectedTaskId: 't' })?.id).toBe('3');
    expect(
      activeConnection({ ...s, selectedTaskId: 't', connectionId: '1' })?.id,
    ).toBe('1');
    expect(
      activeConnection({ ...s, repos: [], connections: [conn('9')] })?.id,
    ).toBe('9');
    expect(activeConnection({ ...s, connections: [] })).toBeNull();
  });

  it("names the task's own project on its task, setup and finish pages, over the switcher", () => {
    const s = {
      connections: [conn('1'), conn('3')],
      repos: [repo('b', '3')],
      tasks: [{ ...task('t', []), repoId: 'b' }],
      selectedTaskId: 't' as string | null,
      connectionId: '1' as string | null,
      screen: { kind: 'task' } as Screen,
    };
    expect(activeConnection(s)?.id).toBe('3');
    expect(
      activeConnection({ ...s, screen: { kind: 'setup', taskId: 't' } })?.id,
    ).toBe('3');
    expect(
      activeConnection({
        ...s,
        selectedTaskId: null,
        screen: { kind: 'finish', taskId: 't' },
      })?.id,
    ).toBe('3');
    expect(activeConnection({ ...s, screen: { kind: 'sprint' } })?.id).toBe(
      '1',
    );
  });
});

describe('telemetry', () => {
  it('tracks screens, the Usage tab, focus mode and error notices', () => {
    const { tracked } = installFakeApi();
    useStore.setState({ tasks: [task('t1', ['a'])] });
    useStore.getState().go({ kind: 'settings' });
    useStore.getState().go({ kind: 'settings' });
    useStore.getState().setTab('t1', USAGE_TAB);
    useStore.getState().setTab('t1', USAGE_TAB);
    useStore.getState().toggleFocus();
    useStore.getState().notify('error', 'Setup failed: x');
    useStore.getState().notify('info', 'Settings saved');
    expect(tracked).toEqual([
      { type: 'pageView', name: 'settings', props: undefined },
      { type: 'event', name: 'usage.opened', props: { via: 'tab' } },
      { type: 'event', name: 'focus.toggled', props: { on: true } },
      {
        type: 'event',
        name: 'notice',
        props: { level: 'error', message: 'Setup failed: x' },
      },
    ]);
  });
});

describe('home start', () => {
  it('starts on Home and Back falls back to Home', () => {
    expect(useStore.getInitialState().screen).toEqual({ kind: 'home' });
    useStore.setState({ previous: null, screen: { kind: 'settings' } });
    useStore.getState().back();
    expect(useStore.getState().screen).toEqual({ kind: 'home' });
  });
});
