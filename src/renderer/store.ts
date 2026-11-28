import { create } from 'zustand';
import type { AttentionSnapshot } from '../shared/attention';
import type { SourceType } from '../shared/brain';
import { brainAskKey, type AskProgress } from '../shared/askProgress';
import { askOwner, type AskExchange, type AskThread } from '../shared/brainAsk';
import type { NewReviewComment, ReviewScope } from '../shared/review';
import type { ReadingBrain } from '../shared/reading';
import type { AppSettings } from '../shared/usage';
import type {
  Connection,
  Notice,
  Repo,
  Sprint,
  TaskView,
  WorkItemRef,
} from '../shared/types';
import { taskConnectionId } from '../shared/workspaces';
import { api, onSettingsSaved } from './api';
import { firstScreen } from './onboardingState';
import type { ReadingNudge } from './readingFeed';
import {
  restoreDraft,
  saveDraft,
  type ComposerDraft,
} from './components/brain/composer/draftStorage';
import type { RepoFold } from './review/repoGroups';
import { track, trackScreen } from './telemetry';
import {
  clampNavWidth,
  readNavWidth,
  readPrefs,
  writeNavWidth,
  writePref,
} from './uiPrefs';

export const USAGE_TAB = 'usage';
export const DOCS_TAB = 'docs';
export const CHANGES_TAB = 'changes';
export const BRAIN_TAB = 'brain';
/** Tab ids of HTML files opened in a tab start with this. */
const VIEW_PREFIX = 'view:';
/** Tabs that are not a terminal: always valid. */
const FIXED_TABS = new Set([USAGE_TAB, DOCS_TAB, CHANGES_TAB, BRAIN_TAB]);

export type { AskExchange };

/** Which thread an asker's current exchanges are: its id, its brain and when it began. */
type ThreadMeta = { id: string; brainId: string; startedAt: number };

/** The task of an asker's key (`askOwner`); null for a brain's own page. */
const ownerTask = (owner: string): string | null =>
  owner.startsWith('brain:') ? null : owner;

let threadSeq = 0;
const newThreadId = () => `th${Date.now().toString(36)}-${++threadSeq}`;

/** Every thread, the askers' current ones marked, as main keeps them (`brainAsk:save`). */
export function askThreadsToSave(
  s: Pick<Store, 'brainAsksByTask' | 'brainAskThread' | 'brainAskEarlier'>,
): AskThread[] {
  const current = Object.entries(s.brainAsksByTask).flatMap(
    ([owner, exchanges]): AskThread[] => {
      const meta = s.brainAskThread[owner];
      return meta && exchanges.length > 0
        ? [{ ...meta, taskId: ownerTask(owner), current: true, exchanges }]
        : [];
    },
  );
  return [...current, ...s.brainAskEarlier];
}
/** How a question was asked, for the count of each. */
export type AskVia = 'typed' | 'suggested' | 'follow-up';
let askSeq = 0;

/** Values from IPC are plain JSON, so equal JSON means nothing changed. */
const sameJson = (a: unknown, b: unknown) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** `next`, reusing the objects of `prev` that did not change, so a component given one skips its render. */
function keepUnchanged(prev: TaskView[], next: TaskView[]): TaskView[] {
  const byId = new Map(prev.map((t) => [t.id, t]));
  const kept = next.map((t) => {
    const old = byId.get(t.id);
    return old && sameJson(old, t) ? old : t;
  });
  return kept.length === prev.length && kept.every((t, i) => t === prev[i])
    ? prev
    : kept;
}

/** An HTML file shown in a tab of the task (in memory only, gone after a relaunch). */
export type HtmlView = {
  id: string;
  /** Worktree-relative, or absolute for a file outside the worktrees. */
  path: string;
  workspaceId?: string;
  name: string;
};

/** A comment being written on the Changes tab. */
export type ReviewDraft = NewReviewComment;
/** Where the Changes tab was, kept per task so leaving the tab (Send to an agent does) loses nothing. */
export type ReviewView = {
  scope: ReviewScope;
  selected: { workspaceId: string; path: string } | null;
  draft: ReviewDraft | null;
  /** Folders folded in the file tree, as `dirKey` keys. */
  collapsed: string[];
  /** The repo the Changes tab is narrowed to (multi-repo tasks), null for all. */
  repoFilter: string | null;
  /** Repo groups folded or opened by hand, per workspace id; absent means automatic. */
  repoFolds: Record<string, RepoFold>;
};
export const DEFAULT_REVIEW_VIEW: ReviewView = {
  scope: { kind: 'all' },
  selected: null,
  draft: null,
  collapsed: [],
  repoFilter: null,
  repoFolds: {},
};

/** Every screen is a full page next to the nav; `task` shows the selected task. */
export type Screen =
  | { kind: 'home' }
  /** First run: the three setup steps. */
  | { kind: 'get-started' }
  /** The Agents step as a page (from Get started; Settings shows the same section inline). */
  | { kind: 'agents'; from: 'settings' | 'get-started' }
  /** The brain step as a page (from Get started). */
  | { kind: 'brain-new'; from: 'get-started' }
  /** Dreams: what dreaming did and what it waits for. */
  | { kind: 'dreams' }
  /** "Let Shellie dream": setting up and switching on. */
  | { kind: 'dream-setup' }
  /** One repo's dream result, for review. */
  | { kind: 'dream'; repoId: string }
  | { kind: 'sprint' }
  /** Every task's time in one week, across projects (for timesheets). */
  | { kind: 'week' }
  /** The active project's overview page. */
  | { kind: 'project' }
  /** A brain: the local knowledge folder of one Azure DevOps project. */
  | {
      kind: 'brain';
      brainId: string;
      /** Where the page puts the cursor on open: the Ask box, the Wiki tab or the drop zone; `explore` opens its Explore view. */
      focus?: 'ask' | 'wiki' | 'drop' | 'explore';
      /** A page, long read or letter to open in the Read view; another `n` opens it again. */
      open?: { path: string; n: number };
    }
  /** A `shellie://join` link opened, or Join on the "Your team has a brain" card (`via: 'card'`): the join screen. */
  | { kind: 'brain-join'; link: string; via?: 'card' }
  | { kind: 'task' }
  | {
      kind: 'new-task';
      workItem?: WorkItemRef;
      repoId?: string;
      connectionId?: string;
      /** Opened as a task from a dream of `repoId`. */
      dream?: NewTaskDream;
    }
  | { kind: 'setup'; taskId: string }
  | { kind: 'finish'; taskId: string }
  /** `folder` is a folder already picked, inspected when the page opens. */
  | {
      kind: 'add-repo';
      from: 'settings' | 'get-started';
      folder?: string;
      connectionId?: string;
    }
  /** With `connectionId`, adds projects to that connection's organization with its stored token. */
  | { kind: 'connect'; from: 'settings' | 'get-started'; connectionId?: string }
  /**
   * `section` is the id of a settings category (or row) to scroll to on open; `repoId` opens the
   * Repository scope on that repo; `scope` picks the tab when neither decides it.
   */
  | {
      kind: 'settings';
      section?: string;
      repoId?: string;
      connectionId?: string;
      scope?: 'user' | 'project' | 'repo';
    }
  | { kind: 'secrets'; repoId?: string }
  | { kind: 'secrets-import'; repoId: string };

/** A dream's branch to make a task on (`dream:openAsTask`), the dream's id for `fromDream`, and the task's name. */
export type NewTaskDream = { id: string; branch: string; name: string };

/** A file dropped on a brain, waiting for its type and note before it goes in. */
export type BrainPendingFile = {
  path: string;
  name: string;
  type: SourceType;
  note: string;
};

export type Store = {
  screen: Screen;
  /** Where Cancel and Escape on New task and Finish return to. */
  previous: Screen | null;
  repos: Repo[];
  tasks: TaskView[];
  connections: Connection[];
  /** The app settings, null until the boot load; every `saveSettings` updates them. */
  settings: AppSettings | null;
  /** The project chosen in the nav's project switcher; null follows the selection. */
  connectionId: string | null;
  selectedTaskId: string | null;
  /** Terminals that wait on the developer, from main. */
  attention: AttentionSnapshot;
  setAttention(attention: AttentionSnapshot): void;
  /** The current sprint per connection, as last fetched; `at` is when (ms). */
  sprints: Record<string, { at: number; sprint: Sprint }>;
  setSprint(connectionId: string, sprint: Sprint): void;
  notices: Notice[];
  /** Every brain's reading list data, from main (`useReadingFeed`). */
  reading: ReadingBrain[];
  setReading(reading: ReadingBrain[]): void;
  /** What a brain's build brought to read, shown as a notice until read, closed or left alone for a while. */
  readingNudge: ReadingNudge | null;
  setReadingNudge(nudge: ReadingNudge | null): void;
  /** Opens a brain's Read view on a page, long read or letter. */
  openInBrain(brainId: string, path: string): void;
  tabByTask: Record<string, string>;
  /**
   * The view tabs (Usage, Docs, Changes, Brain) open in each task's tab row, in the order they were opened. They
   * are not always there: one opens when it is asked for and stays until it is closed. Kept for the session.
   */
  shownTabsByTask: Record<string, string[]>;
  /** Closes a view tab; when it was the one showing, the first terminal shows instead. */
  closeTab(taskId: string, tab: string): void;
  /** The view tabs put in a task's row without being asked for (showTabOnce), so a closed one is not put back. */
  shownOnceByTask: Record<string, string[]>;
  /**
   * Puts a view tab in the task's tab row without selecting it, once per task for the session: the Brain tab of a
   * task with a brain is there from the start. Closed, it stays closed until it is opened again.
   */
  showTabOnce(taskId: string, tab: string): void;
  /**
   * What each task asked its brain from the Brain tab, oldest first. Here and not in the tab, so an answer lands
   * while another task or tab is showing. Kept for the session.
   */
  brainAsksByTask: Record<string, AskExchange[]>;
  /** Whether the task's Brain tab shows its answers instead of its start. */
  brainAskOpenByTask: Record<string, boolean>;
  /**
   * Asks the task's brain and shows the answers: a follow-up continues the session of the last answer. Nothing for
   * an empty question or while one runs. Never rejects: a failure is kept on the exchange.
   */
  /** The thread each asker's current exchanges are (`brainAsksByTask`); set by its first question. */
  brainAskThread: Record<string, ThreadMeta>;
  /** The threads that are no asker's current one: put away by New question, or of a task that is gone. */
  brainAskEarlier: AskThread[];
  /** Puts the asker's thread away as an earlier one and starts empty. Nothing while an answer is coming. */
  newBrainQuestion(owner: string): void;
  /** Makes an earlier thread the asker's current one; the current one takes its place among the earlier. */
  openBrainThread(owner: string, threadId: string): void;
  /** Takes in the threads main kept (once, at the start): an asker that asked meanwhile keeps what it has. */
  loadBrainThreads(threads: AskThread[]): void;
  askBrain(
    /** The asker (`askOwner`): a task's id, or `brain:<id>` for the brain's own page. */
    taskId: string,
    brainId: string,
    question: string,
    via: AskVia,
    /** The exchange this one takes the place of (Ask again, Try again). */
    replaceId?: string,
  ): Promise<void>;
  stopBrainAsk(taskId: string): void;
  /**
   * What the agent of each running ask is doing (`ask:progress`), by `brainAskKey` or `dreamAskKey`. Main sends an
   * empty one when a run starts, so what an earlier run left is never shown for the next.
   */
  askProgress: Record<string, AskProgress>;
  setAskProgress(key: string, p: AskProgress): void;
  setBrainAskOpen(taskId: string, open: boolean): void;
  /** A document a terminal link asked the Docs tab to open; the nonce makes repeats count. */
  docTarget: Record<
    string,
    { path: string; line?: number; workspaceId?: string; nonce: number }
  >;
  reviewByTask: Record<string, ReviewView>;
  /** HTML files open in a tab, per task, in tab order. */
  viewsByTask: Record<string, HtmlView[]>;
  /** Files dropped on a brain and not sent in yet, per brain: they outlive the tab or screen they were dropped on. */
  brainPending: Record<string, BrainPendingFile[]>;
  setBrainPending(
    brainId: string,
    update: (files: BrainPendingFile[]) => BrainPendingFile[],
  ): void;
  /** The Add view's composer per brain (text, files, note, model) until Add or Discard; mirrored to local storage. */
  brainDrafts: Record<string, ComposerDraft>;
  setBrainDraft(
    brainId: string,
    update: (draft: ComposerDraft) => ComposerDraft,
  ): void;
  /** The command palette is on screen. */
  paletteOpen: boolean;
  setPaletteOpen(v: boolean): void;
  focus: boolean;
  navCollapsed: boolean;
  /** The left nav's width in px when not collapsed (#160). */
  navWidth: number;
  /** The task whose Discard confirm shows on its page (#124), else null. */
  discardTaskId: string | null;
  /** Opens the task's page with its Discard confirm. */
  askDiscard(taskId: string): void;
  cancelDiscard(): void;
  go(screen: Screen): void;
  back(): void;
  select(taskId: string | null): void;
  openTask(taskId: string): void;
  setRepos(repos: Repo[]): void;
  setTasks(tasks: TaskView[]): void;
  setConnections(connections: Connection[]): void;
  setConnectionId(id: string | null): void;
  /** Make another project the active one, staying on the page when it follows the project. */
  switchProject(id: string): void;
  notify(level: Notice['level'], message: string): void;
  dismiss(id: string): void;
  load(): Promise<void>;
  setTab(taskId: string, tab: string): void;
  activeTab(taskId: string): string;
  openUsage(taskId: string): void;
  openChanges(taskId: string): void;
  /** Opens the task's page on one tab, such as a terminal. */
  openTab(taskId: string, tab: string): void;
  openDoc(
    taskId: string,
    path: string,
    line?: number,
    workspaceId?: string,
  ): void;
  /** Shows an HTML file in a tab of the task; the same file again focuses its tab. */
  openView(taskId: string, path: string, workspaceId?: string): void;
  closeView(taskId: string, id: string): void;
  setReviewView(
    taskId: string,
    patch: Partial<ReviewView> | ((v: ReviewView) => Partial<ReviewView>),
  ): void;
  toggleFocus(): void;
  setNavCollapsed(v: boolean): void;
  setNavWidth(px: number): void;
};

let noticeSeq = 0;
let openSeq = 0;
let viewSeq = 0;

const fileName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

/**
 * Opens the task's page on one of its tabs; `also` lands in the same update.
 * The tab is set first, so no subscriber sees the task on screen with its previous tab.
 */
function showTab(
  get: () => Store,
  set: (s: Partial<Store>) => void,
  taskId: string,
  tab: string,
  also: Partial<Store> = {},
): void {
  set({
    tabByTask: { ...get().tabByTask, [taskId]: tab },
    ...shownWith(get(), taskId, tab),
    ...also,
  });
  get().select(taskId);
  get().go({ kind: 'task' });
}

/** The store patch that puts a view tab in the task's tab row; nothing for a terminal or a tab already there. */
function shownWith(
  s: Pick<Store, 'shownTabsByTask'>,
  taskId: string,
  tab: string,
): Partial<Store> {
  const shown = s.shownTabsByTask[taskId] ?? [];
  if (!FIXED_TABS.has(tab) || shown.includes(tab)) return {};
  return {
    shownTabsByTask: { ...s.shownTabsByTask, [taskId]: [...shown, tab] },
  };
}

/** Pages that are a step, not a place: Back never returns to them. */
const TRANSIENT = new Set<Screen['kind']>([
  'new-task',
  'finish',
  'add-repo',
  'connect',
  'agents',
  'brain-new',
  'dream-setup',
]);

export const useStore = create<Store>((set, get) => ({
  screen: { kind: 'home' },
  previous: null,
  repos: [],
  tasks: [],
  connections: [],
  settings: null,
  connectionId: null,
  selectedTaskId: null,
  attention: {},
  setAttention: (attention) => {
    const prev = get().attention;
    set({
      attention: Object.fromEntries(
        Object.entries(attention).map(([id, e]) => [
          id,
          sameJson(prev[id], e) ? prev[id] : e,
        ]),
      ),
    });
  },
  sprints: {},
  notices: [],
  reading: [],
  setReading: (reading) => {
    if (!sameJson(get().reading, reading)) set({ reading });
  },
  readingNudge: null,
  setReadingNudge: (readingNudge) => set({ readingNudge }),
  openInBrain: (brainId, path) =>
    get().go({ kind: 'brain', brainId, open: { path, n: ++openSeq } }),
  tabByTask: {},
  shownTabsByTask: {},
  docTarget: {},
  reviewByTask: {},
  viewsByTask: {},
  brainPending: {},
  setBrainPending: (brainId, update) =>
    set((s) => ({
      brainPending: {
        ...s.brainPending,
        [brainId]: update(s.brainPending[brainId] ?? []),
      },
    })),
  brainDrafts: {},
  setBrainDraft: (brainId, update) =>
    set((s) => {
      const draft = update(s.brainDrafts[brainId] ?? restoreDraft(brainId));
      saveDraft(brainId, draft);
      return { brainDrafts: { ...s.brainDrafts, [brainId]: draft } };
    }),
  discardTaskId: null,
  askDiscard: (taskId) => {
    get().select(taskId);
    get().go({ kind: 'task' });
    set({ discardTaskId: taskId });
  },
  cancelDiscard: () => set({ discardTaskId: null }),
  ...readPrefs(),
  navWidth: readNavWidth(),
  go: (screen) => {
    const current = get().screen;
    if (screen.kind !== current.kind) trackScreen(screen.kind);
    set({
      screen,
      previous:
        current.kind === screen.kind || TRANSIENT.has(current.kind)
          ? get().previous
          : current,
      // Discard asks on the task's page only: leaving it drops the question.
      ...(screen.kind === 'task' ? {} : { discardTaskId: null }),
    });
  },
  back: () => {
    const { previous, tasks, selectedTaskId } = get();
    const gone =
      previous?.kind === 'task' && !tasks.some((t) => t.id === selectedTaskId);
    set({
      screen: previous && !gone ? previous : { kind: 'home' },
      previous: null,
    });
  },
  select: (selectedTaskId) =>
    set({
      selectedTaskId,
      ...(selectedTaskId === get().discardTaskId
        ? {}
        : { discardTaskId: null }),
    }),
  openTask: (taskId) => {
    const task = get().tasks.find((t) => t.id === taskId);
    get().select(taskId);
    if (task?.status === 'setting-up' || task?.status === 'setup-failed')
      get().go({ kind: 'setup', taskId });
    else get().go({ kind: 'task' });
  },
  setRepos: (repos) => set({ repos }),
  setConnections: (connections) => set({ connections }),
  setConnectionId: (connectionId) => set({ connectionId }),
  switchProject: (connectionId) => {
    set({ connectionId });
    if (!FOLLOWS_PROJECT.has(get().screen.kind)) get().go({ kind: 'home' });
  },
  setSprint: (connectionId, sprint) =>
    set((s) => ({
      sprints: { ...s.sprints, [connectionId]: { at: Date.now(), sprint } },
    })),
  setTasks: (tasks) => {
    // No auto-select: the app opens on Home and only the user picks a task.
    const selected = get().selectedTaskId;
    const stillThere = tasks.some((t) => t.id === selected);
    const ids = new Set(tasks.map((t) => t.id));
    // An asker that is a task which is gone; a brain's own page is never one.
    const stays = (owner: string) =>
      ownerTask(owner) === null || ids.has(owner);
    const kept = <T>(by: Record<string, T>) =>
      Object.keys(by).every(stays)
        ? by
        : Object.fromEntries(Object.entries(by).filter(([id]) => stays(id)));
    const before = get();
    // What a removed task asked stays, among the earlier threads (the Brain page lists them).
    const orphaned = askThreadsToSave({
      ...before,
      brainAskEarlier: [],
    })
      .filter((t) => t.taskId !== null && !ids.has(t.taskId))
      .map((t) => ({ ...t, current: false }));
    set({
      tasks: keepUnchanged(before.tasks, tasks),
      selectedTaskId: stillThere ? selected : null,
      brainAsksByTask: kept(before.brainAsksByTask),
      brainAskOpenByTask: kept(before.brainAskOpenByTask),
      brainAskThread: kept(before.brainAskThread),
      ...(orphaned.length > 0
        ? { brainAskEarlier: [...before.brainAskEarlier, ...orphaned] }
        : {}),
    });
  },
  notify: (level, message) => {
    // Main scrubs the message (paths, repo and work item names) before it is sent.
    if (level !== 'info')
      track('notice', { level, message: message.slice(0, 200) });
    const id = `n${++noticeSeq}`;
    set({ notices: [...get().notices, { id, level, message }] });
  },
  dismiss: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
  setTab: (taskId, tab) => {
    if (tab === USAGE_TAB && get().activeTab(taskId) !== USAGE_TAB)
      track('usage.opened', { via: 'tab' });
    set({
      tabByTask: { ...get().tabByTask, [taskId]: tab },
      ...shownWith(get(), taskId, tab),
    });
  },
  closeTab: (taskId, tab) => {
    const { [taskId]: selected, ...others } = get().tabByTask;
    set({
      shownTabsByTask: {
        ...get().shownTabsByTask,
        [taskId]: (get().shownTabsByTask[taskId] ?? []).filter(
          (t) => t !== tab,
        ),
      },
      // Without a choice, activeTab falls back to the first terminal.
      ...(selected === tab ? { tabByTask: others } : {}),
    });
  },
  shownOnceByTask: {},
  showTabOnce: (taskId, tab) => {
    const once = get().shownOnceByTask[taskId] ?? [];
    if (once.includes(tab)) return;
    set({
      shownOnceByTask: { ...get().shownOnceByTask, [taskId]: [...once, tab] },
      ...shownWith(get(), taskId, tab),
    });
  },
  brainAsksByTask: {},
  brainAskOpenByTask: {},
  brainAskThread: {},
  brainAskEarlier: [],
  newBrainQuestion: (owner) =>
    set((s) => {
      const exchanges = s.brainAsksByTask[owner] ?? [];
      const meta = s.brainAskThread[owner];
      if (
        !meta ||
        exchanges.length === 0 ||
        exchanges.some((e) => e.status === 'running')
      )
        return {};
      const { [owner]: _thread, ...threads } = s.brainAskThread;
      const { [owner]: _asks, ...asks } = s.brainAsksByTask;
      return {
        brainAskThread: threads,
        brainAsksByTask: asks,
        brainAskEarlier: [
          { ...meta, taskId: ownerTask(owner), current: false, exchanges },
          ...s.brainAskEarlier,
        ],
      };
    }),
  openBrainThread: (owner, threadId) =>
    set((s) => {
      const wanted = s.brainAskEarlier.find((t) => t.id === threadId);
      const exchanges = s.brainAsksByTask[owner] ?? [];
      if (!wanted || exchanges.some((e) => e.status === 'running')) return {};
      const meta = s.brainAskThread[owner];
      const put: AskThread[] =
        meta && exchanges.length > 0
          ? [{ ...meta, taskId: ownerTask(owner), current: false, exchanges }]
          : [];
      return {
        brainAskThread: {
          ...s.brainAskThread,
          [owner]: {
            id: wanted.id,
            brainId: wanted.brainId,
            startedAt: wanted.startedAt,
          },
        },
        brainAsksByTask: { ...s.brainAsksByTask, [owner]: wanted.exchanges },
        brainAskOpenByTask: { ...s.brainAskOpenByTask, [owner]: true },
        brainAskEarlier: [
          ...put,
          ...s.brainAskEarlier.filter((t) => t.id !== threadId),
        ],
      };
    }),
  loadBrainThreads: (threads) =>
    set((s) => {
      const asks = { ...s.brainAsksByTask };
      const meta = { ...s.brainAskThread };
      const earlier = [...s.brainAskEarlier];
      // A thread that is here already (the load ran twice) is not taken in again.
      const have = new Set([
        ...Object.values(meta).map((m) => m.id),
        ...earlier.map((t) => t.id),
      ]);
      for (const t of threads) {
        if (have.has(t.id)) continue;
        have.add(t.id);
        const owner = askOwner(t.taskId, t.brainId);
        if (t.current && !meta[owner] && !(asks[owner]?.length ?? 0)) {
          asks[owner] = t.exchanges;
          meta[owner] = {
            id: t.id,
            brainId: t.brainId,
            startedAt: t.startedAt,
          };
        } else earlier.push({ ...t, current: false });
      }
      return {
        brainAsksByTask: asks,
        brainAskThread: meta,
        brainAskEarlier: earlier,
      };
    }),
  askProgress: {},
  setAskProgress: (key, p) =>
    set((s) => ({ askProgress: { ...s.askProgress, [key]: p } })),
  askBrain: async (taskId, brainId, question, via, replaceId) => {
    const q = question.trim();
    const all = get().brainAsksByTask[taskId] ?? [];
    if (!q || all.some((e) => e.status === 'running')) return;
    track('brain.screen.action', { action: `ask-${via}` });
    // Unlike any id kept from an earlier start of the app.
    const id = `ask${Date.now().toString(36)}-${++askSeq}`;
    // What the agent of the question before was doing is not this one's (main says so too, a moment later).
    const key = brainAskKey(taskId);
    if (get().askProgress[key])
      set((s) => {
        const { [key]: _gone, ...rest } = s.askProgress;
        return { askProgress: rest };
      });
    // Asked again: the new exchange takes the place of the one that was stopped or could not finish.
    const at = replaceId ? all.findIndex((e) => e.id === replaceId) : -1;
    const before = at === -1 ? all : all.slice(0, at);
    const after = at === -1 ? [] : all.slice(at + 1);
    const resumed = before.findLast((e) => e.answer?.sessionId)?.answer;
    const resume = resumed?.sessionId ?? null;
    const patch = (over: Partial<AskExchange>) =>
      set((s) => {
        const thread = s.brainAsksByTask[taskId];
        // The task went away while the agent read: nothing to fill in.
        if (!thread?.some((e) => e.id === id)) return {};
        return {
          brainAsksByTask: {
            ...s.brainAsksByTask,
            [taskId]: thread.map((e) => (e.id === id ? { ...e, ...over } : e)),
          },
        };
      });
    set((s) => ({
      brainAsksByTask: {
        ...s.brainAsksByTask,
        [taskId]: [
          ...before,
          {
            id,
            question: q,
            status: 'running',
            startedAt: Date.now(),
            answer: null,
            error: null,
            refused: null,
          },
          ...after,
        ],
      },
      brainAskOpenByTask: { ...s.brainAskOpenByTask, [taskId]: true },
      // The asker's first question begins its thread.
      ...(s.brainAskThread[taskId]
        ? {}
        : {
            brainAskThread: {
              ...s.brainAskThread,
              [taskId]: { id: newThreadId(), brainId, startedAt: Date.now() },
            },
          }),
    }));
    try {
      const out = await api().invoke(
        'brain:ask',
        brainId,
        ownerTask(taskId),
        q,
        resume,
        taskId,
        resumed?.agent ?? null,
      );
      if (out.ok) patch({ status: 'done', answer: out.answer });
      else if (out.stopped) patch({ status: 'stopped', endedAt: Date.now() });
      else
        patch({ status: 'failed', error: out.message, refused: out.refused });
    } catch (e) {
      patch({ status: 'failed', error: (e as Error).message });
    }
  },
  stopBrainAsk: (taskId) => {
    track('brain.screen.action', { action: 'ask-stop' });
    void api()
      .invoke('brain:askStop', taskId)
      .catch(() => undefined);
  },
  setBrainAskOpen: (taskId, open) =>
    set((s) => ({
      brainAskOpenByTask: { ...s.brainAskOpenByTask, [taskId]: open },
    })),
  activeTab: (taskId) => {
    const task = get().tasks.find((t) => t.id === taskId);
    const want = get().tabByTask[taskId];
    if (want !== undefined && FIXED_TABS.has(want)) return want;
    if (
      want?.startsWith(VIEW_PREFIX) &&
      get().viewsByTask[taskId]?.some((v) => v.id === want)
    )
      return want;
    if (task && want && task.terminals.some((t) => t.id === want)) return want;
    return task?.terminals[0]?.id ?? USAGE_TAB;
  },
  openUsage: (taskId) => {
    track('usage.opened', { via: 'strip' });
    showTab(get, set, taskId, USAGE_TAB);
  },
  openChanges: (taskId) => showTab(get, set, taskId, CHANGES_TAB),
  openTab: (taskId, tab) => showTab(get, set, taskId, tab),
  openDoc: (taskId, path, line, workspaceId) => {
    showTab(get, set, taskId, DOCS_TAB, {
      docTarget: {
        ...get().docTarget,
        [taskId]: {
          path,
          line,
          workspaceId,
          nonce: Date.now() + Math.random(),
        },
      },
    });
  },
  openView: (taskId, path, ws) => {
    const workspaceId = ws || undefined;
    const views = get().viewsByTask[taskId] ?? [];
    const found = views.find(
      (v) => v.path === path && v.workspaceId === workspaceId,
    );
    if (found) return showTab(get, set, taskId, found.id);
    const view: HtmlView = {
      id: `${VIEW_PREFIX}${++viewSeq}`,
      path,
      ...(workspaceId ? { workspaceId } : {}),
      name: fileName(path),
    };
    showTab(get, set, taskId, view.id, {
      viewsByTask: { ...get().viewsByTask, [taskId]: [...views, view] },
    });
  },
  closeView: (taskId, id) => {
    const views = get().viewsByTask[taskId] ?? [];
    // activeTab falls back to the first terminal (or Usage) once the view is gone.
    set({
      viewsByTask: {
        ...get().viewsByTask,
        [taskId]: views.filter((v) => v.id !== id),
      },
    });
  },
  setReviewView: (taskId, patch) => {
    const cur = get().reviewByTask[taskId] ?? DEFAULT_REVIEW_VIEW;
    const next = {
      ...cur,
      ...(typeof patch === 'function' ? patch(cur) : patch),
    };
    set({ reviewByTask: { ...get().reviewByTask, [taskId]: next } });
  },
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  toggleFocus: () => {
    const focus = !get().focus;
    track('focus.toggled', { on: focus });
    writePref('focus', focus);
    set({ focus });
  },
  setNavCollapsed: (navCollapsed) => {
    track('nav.toggled', { collapsed: navCollapsed });
    writePref('navCollapsed', navCollapsed);
    set({ navCollapsed });
  },
  setNavWidth: (px) => {
    const navWidth = clampNavWidth(px);
    writeNavWidth(navWidth);
    set({ navWidth });
  },
  load: async () => {
    const [repos, tasks, connections, settings] = await Promise.all([
      api().invoke('repos:list'),
      api().invoke('tasks:list'),
      api().invoke('connections:list'),
      api().invoke('settings:get'),
    ]);
    get().setRepos(repos);
    get().setTasks(tasks);
    get().setConnections(connections);
    set({ settings });
    // The first page is decided once, here; a page opened meanwhile stays.
    if (
      get().screen.kind === 'home' &&
      firstScreen({ settings, repos }) === 'get-started'
    )
      set({ screen: { kind: 'get-started' } });
    trackScreen(get().screen.kind);
  },
}));

onSettingsSaved((settings) => useStore.setState({ settings }));

/** The connection of a task's repo, for its work item icons and live state. */
export const useTaskConnectionId = (
  task: { repoId: string | null; connectionId?: string | null } | null,
) =>
  useStore((s) =>
    task
      ? taskConnectionId(
          { repoId: task.repoId, connectionId: task.connectionId ?? null },
          s.repos,
        )
      : null,
  );

type ConnectionState = Pick<
  Store,
  'connections' | 'connectionId' | 'repos' | 'tasks' | 'selectedTaskId'
> & { screen?: Screen };

/**
 * The pages that show the active project, or no project at all: a switch of project leaves them on screen. Any
 * other page (a task, a brain, a dream result, a form) belongs to the project left behind, so a switch goes Home.
 */
const FOLLOWS_PROJECT: ReadonlySet<Screen['kind']> = new Set([
  'home',
  'sprint',
  'week',
  'dreams',
  'project',
  'settings',
  'secrets',
]);

/** The task whose page is on screen: the task page, or its setup or finish page; null elsewhere. */
export function taskOnScreen(s: {
  screen?: Screen;
  selectedTaskId: string | null;
}): string | null {
  switch (s.screen?.kind) {
    case 'task':
      return s.selectedTaskId;
    case 'setup':
    case 'finish':
      return s.screen.taskId;
    default:
      return null;
  }
}

/**
 * The project the shell shows. On a task's own pages, the task's repo connection; otherwise the one picked in
 * the switcher, else the selected task's repo connection, else the first linked repo's, else the first connection.
 */
export function activeConnection(s: ConnectionState): Connection | null {
  const byId = (id: string | null | undefined) =>
    id ? (s.connections.find((c) => c.id === id) ?? null) : null;
  const repoOf = (taskId: string | null) => {
    const task = s.tasks.find((t) => t.id === taskId);
    return s.repos.find((r) => r.id === task?.repoId);
  };
  const taskConnection = (taskId: string | null) =>
    s.tasks.find((t) => t.id === taskId)?.connectionId;
  const taskRepo = repoOf(s.selectedTaskId);
  const onScreen = taskOnScreen(s);
  return (
    byId(taskConnection(onScreen)) ??
    byId(repoOf(onScreen)?.connectionId) ??
    byId(s.connectionId) ??
    byId(taskRepo?.connectionId) ??
    byId(s.repos.find((r) => r.connectionId)?.connectionId) ??
    s.connections[0] ??
    null
  );
}
