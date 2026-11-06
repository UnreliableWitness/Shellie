import {
  Code16Regular,
  PanelLeftContract16Regular,
  PanelLeftExpand16Regular,
} from '@fluentui/react-icons';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DocFile, SessionDoc, TaskView } from '../../../shared/types';
import {
  activeHome,
  activeWorkspaces,
  docsTarget,
} from '../../../shared/workspaces';
import { api, tryInvoke } from '../../api';
import { errorMessage } from '../../../shared/errors';
import {
  readDocsMode,
  readDocState,
  readListCollapsed,
  writeDocsMode,
  writeDocState,
  writeListCollapsed,
  type DocsMode,
  type DocView,
} from '../../docs/docsPrefs';
import {
  buildDocTree,
  type TreeFolder,
  type TreeNode,
} from '../../docs/docTree';
import { holdWatch } from '../../review/holdWatch';
import { useStore } from '../../store';
import { track } from '../../telemetry';
import { modKey, Pivots } from '../ui';
import { DocsList, TASK_FILE } from './DocsList';
import { SendTo } from './SendTo';
import { DocsBody, type Doc } from './DocsBody';

type From = 'list' | 'link' | 'terminal';

/** A change that can alter the file list: a Markdown file, or a path without an extension (a folder). */
const affectsList = (paths: string[]): boolean =>
  paths.some((p) => {
    const name = p.split('/').pop() ?? '';
    return /\.(md|markdown)$/i.test(name) || !name.includes('.');
  });

/** Targets already acted on, so returning to the tab does not replay an old terminal link. */
const handledTargets = new Map<string, number>();
export const resetDocTargetsForTests = () => handledTargets.clear();

/** How often the session list is asked for while shown (transcripts are read incrementally in main). */
const SESSION_POLL_MS = 3000;

const firstFile = (
  nodes: TreeNode[],
  ok: (d: SessionDoc) => boolean,
): SessionDoc | null => {
  for (const n of nodes) {
    const hit =
      n.kind === 'file'
        ? ok(n.doc)
          ? n.doc
          : null
        : firstFile(n.children, ok);
    if (hit) return hit;
  }
  return null;
};

function DocsPane({
  task,
  tid,
  wsId,
  rootName,
  mode,
  onMode,
  switcher,
}: {
  task: TaskView;
  /** The docs target: the task id, or `<taskId>#<workspaceId>`. */
  tid: string;
  /** The workspace whose worktree this pane reads relative paths in. */
  wsId: string;
  rootName(workspaceId: string): string;
  mode: DocsMode;
  onMode(m: DocsMode): void;
  switcher: ReactNode;
}) {
  const notify = useStore((s) => s.notify);
  const openDoc = useStore((s) => s.openDoc);
  const target = useStore((s) => s.docTarget[task.id]);
  const [files, setFiles] = useState<DocFile[] | null>(null);
  const [session, setSession] = useState<SessionDoc[] | null>(null);
  const [filter, setFilter] = useState('');
  const [listCollapsed, setListCollapsed] = useState(readListCollapsed);
  const [current, setCurrent] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const asset = useCallback(
    (path: string) => api().invoke('docs:asset', tid, path),
    [tid],
  );
  const [view, setView] = useState<DocView>(() => readDocState(tid).view);
  const [highlight, setHighlight] = useState<{
    line: number;
    n: number;
  } | null>(null);
  // The line a terminal link asked for, kept after the highlight fades, for Open in VS Code.
  const targetLine = useRef<{ path: string; line: number } | null>(null);
  const listing = useRef({ busy: false, again: false });
  const sessionListing = useRef({ busy: false, again: false });
  const sessionRef = useRef<SessionDoc[] | null>(null);
  const [updated, setUpdated] = useState(false);
  const [slow, setSlow] = useState(false);
  const [live, setLive] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const token = useRef(0);
  const mtime = useRef<number | null>(null);
  const pending = useRef<{ scroll?: number; anchor?: string }>({});
  // Start from what is stored so an early persist cannot erase the remembered file.
  const saved = useRef(readDocState(tid));
  const timers = useRef<{ chip?: number; save?: number }>({});
  const currentRef = useRef(current);
  currentRef.current = current;
  const docRef = useRef(doc);
  docRef.current = doc;

  const persist = useCallback(() => {
    const s = saved.current;
    writeDocState(tid, { path: s.path, view: s.view, scroll: s.scroll });
  }, [tid]);

  /** Loads the file list; a call while one is in flight runs once more after it instead of overlapping. */
  const loadFiles = useCallback(async () => {
    const l = listing.current;
    if (l.busy) {
      l.again = true;
      return;
    }
    l.busy = true;
    try {
      do {
        l.again = false;
        try {
          setFiles((await api().invoke('docs:list', tid)).files);
        } catch (e) {
          notify('error', errorMessage(e));
          setFiles((f) => f ?? []);
        }
      } while (l.again);
    } finally {
      l.busy = false;
    }
  }, [tid, notify]);

  /** Loads the session docs, like loadFiles; an open doc outside the worktree reloads when its file changed. */
  const loadSession = useCallback(async () => {
    const l = sessionListing.current;
    if (l.busy) {
      l.again = true;
      return;
    }
    l.busy = true;
    try {
      do {
        l.again = false;
        try {
          const next = (await api().invoke('docs:session', tid)).files;
          const prev = sessionRef.current;
          sessionRef.current = next;
          setSession(next);
          const open = currentRef.current;
          const outside = (l: SessionDoc[] | null) =>
            l?.find((d) => d.workspaceId === null && d.path === open);
          const was = outside(prev);
          const now = outside(next);
          if (open && was && now && was.mtimeMs !== now.mtimeMs)
            void readRef.current(open, false);
        } catch (e) {
          notify('error', errorMessage(e));
          setSession((f) => f ?? []);
        }
      } while (l.again);
    } finally {
      l.busy = false;
    }
  }, [tid, notify]);

  /** Reads a document. A first load shows a spinner; a reload keeps the old text until the new arrives. */
  const read = useCallback(
    async (path: string, first: boolean) => {
      const mine = ++token.current;
      let spin: number | undefined;
      if (first) {
        setSlow(false);
        spin = window.setTimeout(() => setSlow(true), 150);
      }
      try {
        const r = await api().invoke('docs:read', tid, path);
        if (mine !== token.current) return;
        if (path !== currentRef.current) return;
        mtime.current = r.mtimeMs;
        const shown = docRef.current;
        if (
          !first &&
          shown?.path === path &&
          shown.text !== r.text &&
          (scrollRef.current?.scrollTop ?? 0) > 0
        ) {
          setUpdated(true);
          window.clearTimeout(timers.current.chip);
          timers.current.chip = window.setTimeout(
            () => setUpdated(false),
            2000,
          );
        }
        setDoc({ path, text: r.text, error: null, deleted: false });
      } catch (e) {
        if (mine !== token.current || path !== currentRef.current) return;
        const msg = errorMessage(e);
        setDoc((d) => {
          if (
            msg === 'Not found' &&
            !first &&
            d?.path === path &&
            d.text !== null
          )
            return { ...d, deleted: true };
          if (msg === 'Too large')
            return { path, text: null, error: 'too-large', deleted: false };
          return { path, text: null, error: msg, deleted: false };
        });
      } finally {
        window.clearTimeout(spin);
        if (first) setSlow(false);
      }
    },
    [tid],
  );
  const readRef = useRef(read);
  readRef.current = read;

  const openPath = useCallback(
    (
      path: string,
      opts: { from: From; view?: DocView; line?: number; anchor?: string },
    ) => {
      const nextView = opts.view ?? (opts.line ? 'source' : undefined);
      if (nextView) setView(nextView);
      track('docs.opened', {
        view: nextView ?? saved.current.view,
        from: opts.from,
      });
      const line = opts.line;
      targetLine.current = line ? { path, line } : null;
      setHighlight((h) => (line ? { line, n: (h?.n ?? 0) + 1 } : null));
      if (path === currentRef.current) {
        scrollToAnchor(scrollRef.current, opts.anchor);
        return;
      }
      pending.current = { anchor: opts.anchor };
      saved.current = { ...saved.current, path, scroll: 0 };
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      setCurrent(path);
    },
    [],
  );

  // File list: on mount and on every change event for this task. The session list also polls, for transcripts
  // and files outside the worktree that no watcher sees.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    const load = () =>
      void (modeRef.current === 'session' ? loadSession() : loadFiles());
    load();
    const off = api().on('docs:changed', (p) => {
      if (p.taskId !== tid) return;
      if (affectsList(p.paths)) load();
      const open = currentRef.current;
      if (open && p.paths.includes(open)) void read(open, false);
    });
    return off;
  }, [tid, mode, loadFiles, loadSession, read]);
  useEffect(() => {
    if (mode !== 'session') return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void loadSession();
    }, SESSION_POLL_MS);
    return () => window.clearInterval(id);
  }, [mode, loadSession]);

  const q = filter.trim().toLowerCase();
  const tree: TreeFolder[] = useMemo(
    () =>
      buildDocTree(
        (session ?? []).filter((d) => !q || d.path.toLowerCase().includes(q)),
        activeWorkspaces(task).map((w) => w.id),
        rootName,
      ),
    [session, q, task, rootName],
  );
  /** A session doc this pane opens itself: in its own worktree, or outside every worktree. */
  const ownDoc = useCallback(
    (d: SessionDoc) => d.workspaceId === null || d.workspaceId === wsId,
    [wsId],
  );
  const openSession = (d: SessionDoc) => {
    if (ownDoc(d)) openPath(d.path, { from: 'list' });
    // Another repo's doc: its own pane opens it (the switcher follows).
    else openDoc(task.id, d.path, undefined, d.workspaceId ?? undefined);
  };

  // Learn whether the watcher is live; a watcher main stops makes the tab poll.
  useEffect(() => holdWatch('docs:watch', tid, setLive), [tid]);

  // A target from a terminal link wins over the remembered file.
  useEffect(() => {
    if (!target || handledTargets.get(task.id) === target.nonce) return;
    // A doc outside every worktree (an absolute path) opens in whichever pane is shown.
    const outside = /^(?:[A-Za-z]:\/|\/)/.test(target.path);
    if (!outside && targetFor(task, target.workspaceId) !== tid) return;
    handledTargets.set(task.id, target.nonce);
    openPath(target.path, { from: 'terminal', line: target.line });
  }, [target, task.id, tid, openPath]);

  // The first file: remembered, else the task file, README, or the first listed. In the session view: remembered
  // when it is a session doc, else the first one this pane can open.
  useEffect(() => {
    if (current !== null) return;
    const remembered = readDocState(tid);
    let pick: string;
    if (mode === 'session') {
      if (!session || session.length === 0) return;
      const own = session.filter(ownDoc);
      if (own.length === 0) return;
      pick =
        remembered.path && own.some((d) => d.path === remembered.path)
          ? remembered.path
          : (firstFile(tree, ownDoc)?.path ?? own[0].path);
    } else {
      if (!files || files.length === 0) return;
      const has = (p: string | null) => !!p && files.some((f) => f.path === p);
      pick = has(remembered.path)
        ? remembered.path!
        : has(TASK_FILE)
          ? TASK_FILE
          : has('README.md')
            ? 'README.md'
            : files[0].path;
    }
    if (pick === remembered.path)
      pending.current = { scroll: remembered.scroll };
    saved.current = {
      ...saved.current,
      path: pick,
      scroll: pick === remembered.path ? remembered.scroll : 0,
    };
    setCurrent(pick);
    // tree changes with the filter; the pick only matters once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, session, mode, current, tid, ownDoc]);

  useEffect(() => {
    if (current === null) return;
    mtime.current = null;
    setDoc(null);
    void read(current, true);
    persist();
  }, [current, read, persist]);

  useEffect(() => {
    saved.current = { ...saved.current, view };
    persist();
  }, [view, persist]);

  // Restore scroll or jump to an anchor once the text has rendered.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !doc || doc.text === null || doc.path !== current) return;
    const p = pending.current;
    if (p.scroll !== undefined) el.scrollTop = p.scroll;
    else if (p.anchor) scrollToAnchor(el, p.anchor);
    pending.current = {};
  }, [doc, current]);

  // The highlight fades 2 s after the text it marks has rendered (a slow read must not eat it).
  useEffect(() => {
    if (!highlight || !doc || doc.text === null || doc.path !== current) return;
    const id = window.setTimeout(() => setHighlight(null), 2000);
    return () => window.clearTimeout(id);
  }, [highlight, doc, current]);

  // Without a live watcher, poll the open file.
  useEffect(() => {
    if (live !== false || !current) return;
    const id = window.setInterval(() => {
      void (async () => {
        try {
          const r = await api().invoke('docs:read', tid, current);
          if (current !== currentRef.current) return;
          if (mtime.current !== null && r.mtimeMs !== mtime.current)
            void read(current, false);
        } catch {
          if (current === currentRef.current) void read(current, false);
        }
        if (modeRef.current === 'all') void loadFiles();
      })();
    }, 2000);
    return () => window.clearInterval(id);
  }, [live, current, tid, read, loadFiles]);

  useEffect(
    () => () => {
      const t = timers.current;
      window.clearTimeout(t.chip);
      if (t.save !== undefined) {
        window.clearTimeout(t.save);
        persist();
      }
      token.current++;
    },
    [persist],
  );

  const onScroll = () => {
    saved.current.scroll = scrollRef.current?.scrollTop ?? 0;
    if (timers.current.save !== undefined) return;
    timers.current.save = window.setTimeout(() => {
      timers.current.save = undefined;
      persist();
    }, 300);
  };

  const openInEditor = (path: string, line?: number) =>
    tryInvoke(() => api().invoke('docs:openInEditor', tid, path, line), notify);

  const collapse = (v: boolean) => {
    setListCollapsed(v);
    writeListCollapsed(v);
  };

  return (
    <div className="docs">
      <DocsList
        files={files ?? []}
        filter={filter}
        onFilter={setFilter}
        current={current}
        hidden={listCollapsed}
        onOpen={(p) => openPath(p, { from: 'list' })}
        mode={mode}
        onMode={onMode}
        tree={tree}
        sessionLoaded={session !== null}
        isCurrent={(d) => ownDoc(d) && d.path === current}
        onOpenSession={openSession}
      />
      <section className="docs-doc">
        <div className="docs-bar">
          {switcher}
          <button
            type="button"
            className="btn btn-subtle btn-sm"
            aria-label={listCollapsed ? 'Show file list' : 'Hide file list'}
            title={listCollapsed ? 'Show file list' : 'Hide file list'}
            onClick={() => collapse(!listCollapsed)}
          >
            {listCollapsed ? (
              <PanelLeftExpand16Regular />
            ) : (
              <PanelLeftContract16Regular />
            )}
          </button>
          <span className="docs-crumb mono small muted">
            {(current ?? '').split('/').map((part, i, all) => (
              <span key={i}>
                {part}
                {i < all.length - 1 ? ' / ' : ''}
              </span>
            ))}
          </span>
          <Pivots
            label="View"
            items={[
              { key: 'rendered', label: 'Rendered' },
              { key: 'source', label: 'Source' },
            ]}
            selected={view}
            onSelect={setView}
          />
          <button
            type="button"
            className="btn btn-subtle btn-sm"
            disabled={!current}
            onClick={() =>
              current &&
              void openInEditor(
                current,
                targetLine.current?.path === current
                  ? targetLine.current.line
                  : undefined,
              )
            }
          >
            <Code16Regular aria-hidden="true" />
            Open in VS Code
          </button>
          <button
            type="button"
            className="btn btn-subtle btn-sm"
            disabled={!current}
            onClick={() =>
              current &&
              void tryInvoke(
                () => api().invoke('docs:reveal', tid, current),
                notify,
              )
            }
          >
            {modKey === 'Cmd' ? 'Reveal in Finder' : 'Show in Explorer'}
          </button>
        </div>
        {doc?.deleted && (
          <div className="notice warn">This file was deleted.</div>
        )}
        <div
          className="docs-scroll"
          ref={(el) => {
            scrollRef.current = el;
            setScrollEl(el);
          }}
          onScroll={onScroll}
        >
          <DocsBody
            asset={asset}
            empty={
              mode === 'all'
                ? files !== null && files.length === 0
                  ? 'No Markdown files in this worktree'
                  : null
                : session !== null && session.length === 0 && current === null
                  ? 'No session docs yet. Markdown files Claude edits or creates in this task show up here.'
                  : null
            }
            doc={doc}
            current={current}
            slow={slow}
            view={view}
            highlight={highlight?.line ?? null}
            onRetry={(path) => void read(path, true)}
            onOpenDoc={(p, anchor) =>
              openPath(p, { from: 'link', view: 'rendered', anchor })
            }
            onOpenFile={(p) => void openInEditor(p)}
          />
          {updated && <span className="docs-updated">Updated</span>}
        </div>
        {doc?.path && doc.text !== null && (
          <SendTo
            task={task}
            container={scrollEl}
            path={doc.path}
            view={view}
          />
        )}
      </section>
    </div>
  );
}

/** The active home is the plain task id; any other workspace is `<taskId>#<workspaceId>`. */
const targetFor = (task: TaskView, workspaceId: string | undefined): string =>
  workspaceId === undefined || workspaceId === activeHome(task).id
    ? task.id
    : docsTarget(task.id, workspaceId);

export function DocsTab({ task }: { task: TaskView }) {
  const repos = useStore((s) => s.repos);
  const asked = useStore((s) => s.docTarget[task.id]);
  const workspaces = activeWorkspaces(task);
  // A terminal link not yet acted on picks its workspace (also on mount); a handled one is stale.
  const fresh = (a: typeof asked) =>
    a && handledTargets.get(task.id) !== a.nonce ? a.workspaceId : undefined;
  const [picked, setPicked] = useState<string | undefined>(() => fresh(asked));
  useEffect(() => {
    const w = fresh(asked);
    if (w !== undefined) setPicked(w);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  const chosen =
    picked !== undefined && workspaces.some((w) => w.id === picked)
      ? picked
      : activeHome(task).id;
  const tid = targetFor(task, chosen);
  const names = workspaces.map(
    (w) => repos.find((r) => r.id === w.repoId)?.name ?? w.branch,
  );
  const switcher =
    workspaces.length > 1 ? (
      <select
        className="docs-repo"
        aria-label="Repository"
        value={chosen}
        onChange={(e) => setPicked(e.target.value)}
      >
        {workspaces.map((w, i) => (
          <option key={w.id} value={w.id}>
            {names.indexOf(names[i]) === names.lastIndexOf(names[i])
              ? names[i]
              : `${names[i]} (${w.branch})`}
          </option>
        ))}
      </select>
    ) : null;
  const [mode, setMode] = useState<DocsMode>(() => readDocsMode(task.id));
  const onMode = (m: DocsMode) => {
    setMode(m);
    writeDocsMode(task.id, m);
    track('docs.sessionView', { mode: m });
  };
  const nameKey = names.join('\0');
  const rootName = useCallback(
    (id: string) => {
      const i = workspaces.findIndex((w) => w.id === id);
      return i < 0 ? id : names[i];
    },
    // names follow the workspaces and repos; nameKey keeps the callback stable between renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nameKey],
  );
  return (
    <DocsPane
      key={tid}
      task={task}
      tid={tid}
      wsId={chosen}
      rootName={rootName}
      mode={mode}
      onMode={onMode}
      switcher={switcher}
    />
  );
}

function scrollToAnchor(root: HTMLElement | null, anchor?: string) {
  if (!root || !anchor) return;
  for (const el of root.querySelectorAll('[id]'))
    if (el.id === anchor) {
      el.scrollIntoView?.({ block: 'start' });
      return;
    }
}
