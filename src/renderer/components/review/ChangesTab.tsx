import {
  ArrowDown16Regular,
  ArrowUp16Regular,
  ChevronDown16Regular,
  ChevronLeft16Regular,
  ChevronRight16Regular,
  Open16Regular,
  TextBulletListLtr16Regular,
  TextBulletListTree16Regular,
} from '@fluentui/react-icons';
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type FileContent,
  isGenerated,
  type ReviewComment,
  type ReviewFile,
  type ReviewRepo,
  type ReviewSide,
  type ReviewState,
  viewedKey,
} from '../../../shared/review';
import type { TaskView } from '../../../shared/types';
import {
  activeWorkspaces,
  dropsAtFinish,
  repoColor,
} from '../../../shared/workspaces';
import { api, tryInvoke } from '../../api';
import {
  readReviewPrefs,
  type ReviewPrefs,
  writeReviewPrefs,
} from '../../review/reviewPrefs';
import { dirKey, holds, viewOrder } from '../../review/fileTree';
import { isFolded, repoSignature, viewedIn } from '../../review/repoGroups';
import { useReview } from '../../review/useReview';
import {
  DEFAULT_REVIEW_VIEW,
  type ReviewDraft,
  type ReviewView,
  useStore,
} from '../../store';
import { track } from '../../telemetry';
import { ConfirmBar, PopupMenu } from '../ui';
import { CommentBox, CommentCard } from './CommentCard';
import { CommentsList } from './CommentsList';
import {
  DiffView,
  type DiffKey,
  type DiffViewHandle,
  type DiffZone,
} from './DiffView';
import { discardKind, FileTree, type FileRef } from './FileTree';
import { RepoMark } from '../RepoMark';
import { RepoFilter } from './RepoFilter';
import { ScopePicker } from './ScopePicker';
import { SendComments } from './SendComments';

/**
 * One field of the task's ReviewView in the store, as a useState pair: scope, selection and the draft
 * (its text too, so a rebuilt diff zone or leaving the tab loses nothing) outlive this component.
 */
function useViewField<K extends keyof ReviewView>(
  taskId: string,
  key: K,
): [ReviewView[K], (v: SetStateAction<ReviewView[K]>) => void] {
  const value = useStore(
    (s) => (s.reviewByTask[taskId] ?? DEFAULT_REVIEW_VIEW)[key],
  );
  const setView = useStore((s) => s.setReviewView);
  const set = (v: SetStateAction<ReviewView[K]>) =>
    setView(taskId, (cur) => ({
      [key]:
        typeof v === 'function'
          ? (v as (p: ReviewView[K]) => ReviewView[K])(cur[key])
          : v,
    }));
  return [value, set];
}

/** Scroll and cursor per file, per task: kept for the app's lifetime, like the rest of the view. */
const viewStatesByTask = new Map<string, Map<string, unknown>>();
const viewStatesOf = (taskId: string) => {
  let m = viewStatesByTask.get(taskId);
  if (!m) {
    m = new Map();
    viewStatesByTask.set(taskId, m);
  }
  return m;
};

const kb = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Files in the order the Files panel shows them (generated files last), for next/previous file. */
function ordered(
  repos: ReviewRepo[],
  view: ReviewPrefs['fileView'],
): { repo: ReviewRepo; file: ReviewFile }[] {
  return repos.flatMap((r) =>
    [
      ...viewOrder(
        r.files.filter((f) => !isGenerated(f.path, r.collapse)),
        view,
      ),
      ...viewOrder(
        r.files.filter((f) => isGenerated(f.path, r.collapse)),
        view,
      ),
    ].map((file) => ({ repo: r, file })),
  );
}

export function ChangesTab({ task }: { task: TaskView }) {
  const notify = useStore((s) => s.notify);
  const [scope, setScope] = useViewField(task.id, 'scope');
  const { files, state, setState, changedAt, error, refresh } = useReview(
    task,
    scope,
    true,
  );
  const [selected, setSelected] = useViewField(task.id, 'selected');
  // The content with the file and scope it was read for, so another file's text is never shown.
  const [loaded, setLoaded] = useState<{
    key: string;
    content: FileContent | null;
  } | null>(null);
  const [prefs, setPrefs] = useState<ReviewPrefs>(() => readReviewPrefs());
  const [draft, setDraft] = useViewField(task.id, 'draft');
  const [panel, setPanel] = useState<'files' | 'comments'>('files');
  // A save of the draft is on its way: a second submit is ignored.
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // The line to scroll to, for the file it belongs to.
  const [reveal, setReveal] = useState<
    (FileRef & { side: ReviewSide; line: number; seq: number }) | undefined
  >();
  const repos = useStore((s) => s.repos);
  const handle = useRef<DiffViewHandle | null>(null);
  const tracked = useRef(false);

  // The file waiting for the user to confirm its discard, with the scope it was asked in.
  const [discarding, setDiscarding] = useState<{
    repo: ReviewRepo;
    file: ReviewFile;
    scopeKey: string;
  } | null>(null);
  const [discardBusy, setDiscardBusy] = useState(false);

  const [collapsed, setCollapsed] = useViewField(task.id, 'collapsed');
  const [storedFilter, setRepoFilter] = useViewField(task.id, 'repoFilter');
  const [repoFolds, setRepoFolds] = useViewField(task.id, 'repoFolds');
  const inTask = activeWorkspaces(task);
  const multiRepo = inTask.length > 1;
  // The loaded changes span more than one repo (comments then name theirs).
  const multiRepoFiles = (files?.repos.length ?? 0) > 1;
  // A repo that left the task drops the filter.
  const repoFilter =
    multiRepo && inTask.some((w) => w.id === storedFilter)
      ? storedFilter
      : null;
  const viewedMap = state?.viewed ?? {};
  const shownRepos = useMemo(
    () =>
      (files?.repos ?? []).filter(
        (r) => repoFilter === null || r.workspaceId === repoFilter,
      ),
    [files, repoFilter],
  );
  const list = useMemo(
    () => (files ? ordered(shownRepos, prefs.fileView) : []),
    [files, shownRepos, prefs.fileView],
  );
  const repoNameOf = (id: string) =>
    files?.repos.find((r) => r.workspaceId === id)?.name ??
    repos.find((r) => r.id === inTask.find((w) => w.id === id)?.repoId)?.name ??
    id;
  const filterTo = (
    id: string | null,
    via: 'chip' | 'key' | 'breadcrumb' | 'commit' | 'comment',
  ) => {
    if (id === repoFilter) return;
    setRepoFilter(id);
    track('review.repoFiltered', { via });
  };
  const folded = (r: ReviewRepo) =>
    isFolded(r, viewedMap, repoFolds[r.workspaceId]);
  const setFold = (r: ReviewRepo, how: 'open' | 'closed') =>
    setRepoFolds((f) => ({
      ...f,
      [r.workspaceId]: { how, at: repoSignature(r) },
    }));
  const current =
    list.find(
      (x) =>
        x.repo.workspaceId === selected?.workspaceId &&
        x.file.path === selected.path,
    ) ?? null;

  // Keep the selection while the file is still listed; otherwise open the first file (narrowed to one
  // repo: its first file not viewed yet).
  useEffect(() => {
    if (!files) return;
    if (current) return;
    const first =
      (repoFilter !== null &&
        list.find(
          (x) =>
            viewedMap[viewedKey(x.repo.workspaceId, x.file.path)] !==
            x.file.hash,
        )) ||
      list[0];
    // Decided on the selection as it is now, not as this effect's render saw it: a click on a file that
    // lands before this effect runs (a slow machine, right as the list appears) must not be undone.
    setSelected((now) =>
      now &&
      list.some(
        (x) =>
          x.repo.workspaceId === now.workspaceId && x.file.path === now.path,
      )
        ? now
        : first
          ? { workspaceId: first.repo.workspaceId, path: first.file.path }
          : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, current, list]);

  // A file opened inside a folded repo opens the repo.
  useEffect(() => {
    if (!current || !multiRepo || !folded(current.repo)) return;
    setFold(current.repo, 'open');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.workspaceId, selected?.path]);

  // The selected file is always in sight: unfold the folders that hold it.
  useEffect(() => {
    if (!selected) return;
    const hiding = (k: string) =>
      k.startsWith(dirKey(selected.workspaceId, '')) &&
      holds(k.slice(dirKey(selected.workspaceId, '').length), selected.path);
    setCollapsed((c) => (c.some(hiding) ? c.filter((k) => !hiding(k)) : c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.workspaceId, selected?.path]);

  useEffect(() => {
    if (!files || tracked.current) return;
    tracked.current = true;
    track('review.opened', {
      scope: scope.kind,
      files: list.length,
      repos: files.repos.length,
    });
  }, [files, list.length, scope.kind]);

  const fileKey = current
    ? `${current.repo.workspaceId}/${current.file.path}/${current.file.hash}`
    : null;
  const scopeKey = JSON.stringify(scope);
  const showKey = current
    ? `${current.repo.workspaceId}/${current.file.path}|${scopeKey}`
    : null;
  const content = loaded && loaded.key === showKey ? loaded.content : null;
  useEffect(() => {
    if (!current || !showKey) {
      setLoaded(null);
      return;
    }
    let live = true;
    const key = showKey;
    const { path, oldPath, status, binary } = current.file;
    void api()
      .invoke(
        'review:file',
        task.id,
        current.repo.workspaceId,
        { path, ...(oldPath ? { oldPath } : {}), status, binary },
        scope,
      )
      .then((c) => live && setLoaded({ key, content: c }))
      .catch(() => live && setLoaded({ key, content: null }));
    return () => {
      live = false;
    };
    // fileKey covers the file and its content hash; changedAt reloads after a watcher event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, changedAt, task.id, scopeKey]);

  const setPref = (patch: Partial<ReviewPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    writeReviewPrefs(next);
  };

  const setViewed = async (repo: ReviewRepo, file: ReviewFile, on: boolean) => {
    const s = await tryInvoke(
      () =>
        api().invoke(
          'review:setViewed',
          task.id,
          viewedKey(repo.workspaceId, file.path),
          on ? file.hash : null,
        ),
      notify,
    );
    if (s) {
      setState(s);
      if (on) track('review.fileViewed');
      const fold = repoFolds[repo.workspaceId];
      if (
        on &&
        multiRepo &&
        !(fold && fold.at === repoSignature(repo)) &&
        viewedIn(repo, s.viewed) === repo.files.length
      )
        track('review.repoCollapsed', { how: 'auto' });
    }
  };

  const canComment = scope.kind === 'all';
  const comments = state?.comments ?? [];
  // Unresolved comments per file, by viewedKey.
  const openCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of state?.comments ?? [])
      if (c.status !== 'resolved') {
        const k = viewedKey(c.workspaceId, c.path);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    return m;
  }, [state?.comments]);
  const onThisFile = (c: { workspaceId: string; path: string }) =>
    current !== null &&
    c.workspaceId === current.repo.workspaceId &&
    c.path === current.file.path;
  const startDraft = (
    side: ReviewSide,
    startLine: number,
    endLine = startLine,
  ) => {
    if (!canComment || !current) return;
    // A draft with text is never thrown away by another + or c.
    if (draft?.text.trim()) {
      notify('info', 'Finish or cancel the open comment first');
      return;
    }
    const { oldPath } = current.file;
    const d: ReviewDraft = {
      workspaceId: current.repo.workspaceId,
      path: current.file.path,
      // The base side of a renamed file is read at its old path.
      ...(side === 'before' && oldPath ? { oldPath } : {}),
      side,
      startLine,
      endLine,
      text: '',
    };
    setDraft(d);
  };
  const apply = async (run: () => Promise<ReviewState>) => {
    const s = await tryInvoke(run, notify);
    if (s) setState(s);
    return s;
  };
  const saveDraft = async (text: string) => {
    if (!draft || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const { text: _typed, ...where } = draft;
    try {
      if (
        await apply(() =>
          api().invoke('review:addComment', task.id, { ...where, text }),
        )
      )
        setDraft(null);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const resolve = (c: ReviewComment) => {
    track('review.commentResolved', { outdated: c.status === 'outdated' });
    void apply(() =>
      api().invoke('review:updateComment', task.id, c.id, {
        status: 'resolved',
      }),
    );
  };
  const reopen = (c: ReviewComment) =>
    void apply(() =>
      api().invoke('review:updateComment', task.id, c.id, { status: 'open' }),
    );
  const remove = (c: ReviewComment) =>
    void apply(() => api().invoke('review:deleteComment', task.id, c.id));
  const card = (c: ReviewComment) => (
    <CommentCard
      comment={c}
      onEdit={(text) =>
        void apply(() =>
          api().invoke('review:updateComment', task.id, c.id, { text }),
        )
      }
      onResolve={() => resolve(c)}
      onReopen={() => reopen(c)}
      onDelete={() => remove(c)}
    />
  );
  const zones: DiffZone[] = canComment
    ? [
        ...comments
          .filter(
            (c) =>
              onThisFile(c) && (c.status === 'open' || c.status === 'sent'),
          )
          .map((c) => ({
            id: c.id,
            side: c.side,
            afterLine: c.endLine,
            node: card(c),
          })),
        ...(draft && onThisFile(draft)
          ? [
              {
                id: 'draft',
                side: draft.side,
                afterLine: draft.endLine,
                node: (
                  <CommentBox
                    value={draft.text}
                    busy={saving}
                    onChange={(text) =>
                      setDraft((d) => (d ? { ...d, text } : d))
                    }
                    onSave={(t) => void saveDraft(t)}
                    onCancel={() => setDraft(null)}
                  />
                ),
              },
            ]
          : []),
      ]
    : [];
  const outdatedHere = canComment
    ? comments.filter((c) => onThisFile(c) && c.status === 'outdated')
    : [];
  const openComment = (c: ReviewComment) => {
    if (repoFilter !== null && repoFilter !== c.workspaceId)
      filterTo(c.workspaceId, 'comment');
    setScope({ kind: 'all' });
    setPanel('files');
    setSelected({ workspaceId: c.workspaceId, path: c.path });
    setReveal({
      workspaceId: c.workspaceId,
      path: c.path,
      side: c.side,
      line: c.startLine,
      seq: Date.now(),
    });
  };
  const unresolved = comments.filter((c) => c.status !== 'resolved').length;
  const revealHere = reveal && onThisFile(reveal) ? reveal : undefined;
  // A file the user picks drops a pending reveal, so it never fires on a later visit.
  const pick = (ref: FileRef) => {
    setReveal(undefined);
    setSelected(ref);
  };

  const step = (by: number) => {
    if (list.length === 0) return;
    const i = list.findIndex((x) => x === current);
    const next = list[(i + by + list.length) % list.length];
    pick({ workspaceId: next.repo.workspaceId, path: next.file.path });
  };
  // Discarding applies to the working tree: All changes and Uncommitted, never a commit.
  const canDiscard = scope.kind !== 'commits';
  const askDiscard = (repo: ReviewRepo, file: ReviewFile) =>
    setDiscarding({ repo, file, scopeKey: JSON.stringify(scope) });
  const pendingDiscard =
    discarding && discarding.scopeKey === JSON.stringify(scope) && canDiscard
      ? discarding
      : null;
  const confirmDiscard = async () => {
    if (!pendingDiscard || discardBusy) return;
    const { repo, file } = pendingDiscard;
    const at = list.findIndex(
      (x) =>
        x.repo.workspaceId === repo.workspaceId && x.file.path === file.path,
    );
    const wasShown =
      selected?.workspaceId === repo.workspaceId && selected.path === file.path;
    // The file after it in the panel's order, else the one before: where the selection goes.
    const rest = list.filter((_, i) => i !== at);
    const next = at < 0 ? undefined : (rest[at] ?? rest[at - 1]);
    setDiscardBusy(true);
    try {
      const ok = await tryInvoke(async () => {
        await api().invoke(
          'review:discard',
          task.id,
          repo.workspaceId,
          file.path,
          scope,
        );
        return true;
      }, notify);
      if (!ok) return;
      track('review.fileDiscarded', { scope: scope.kind });
      if (wasShown && next)
        pick({ workspaceId: next.repo.workspaceId, path: next.file.path });
      setDiscarding(null);
      refresh();
    } finally {
      setDiscardBusy(false);
    }
  };
  const discardText = (f: ReviewFile) => {
    if (discardKind(f) === 'delete')
      return `Delete ${f.path}? The file is removed from disk. This cannot be undone.`;
    const what =
      scope.kind === 'uncommitted'
        ? 'Its uncommitted changes are lost.'
        : 'It goes back to how it was at the start of the task; uncommitted changes to it are lost.';
    const renamed = f.oldPath
      ? ` ${f.oldPath} comes back and ${f.path} is removed.`
      : '';
    return `Discard changes to ${f.path}?${renamed} ${what} This cannot be undone.`;
  };

  const chips = multiRepo
    ? inTask.map((w) => {
        const r = files?.repos.find((x) => x.workspaceId === w.id);
        return {
          workspaceId: w.id,
          name: repoNameOf(w.id),
          color: repoColor(task, w.id),
          // No count for a repo this scope does not list, or one without changes.
          unviewed:
            r && r.files.length > 0
              ? r.files.length - viewedIn(r, viewedMap)
              : undefined,
        };
      })
    : [];
  const onKey = (key: DiffKey) => {
    if (/^[0-9]$/.test(key)) {
      if (!multiRepo || scope.kind === 'commits') return;
      const n = Number(key);
      if (n === 0) filterTo(null, 'key');
      else if (chips[n - 1]) filterTo(chips[n - 1].workspaceId, 'key');
    } else if (key === 'j') step(1);
    else if (key === 'k') step(-1);
    else if (key === 'n') handle.current?.goToChange('next');
    else if (key === 'p') handle.current?.goToChange('previous');
    else if (key === 'v' && current)
      void setViewed(
        current.repo,
        current.file,
        viewedMap[viewedKey(current.repo.workspaceId, current.file.path)] !==
          current.file.hash,
      );
    else if (key === 'c') {
      const s = handle.current?.selection();
      if (s) startDraft(s.side, s.startLine, s.endLine);
    }
  };

  const total = list.length;
  const viewedCount = list.filter(
    (x) =>
      viewedMap[viewedKey(x.repo.workspaceId, x.file.path)] === x.file.hash,
  ).length;

  const body = () => {
    if (!files)
      return (
        <div className="review-empty">
          {error
            ? `The changes could not be loaded: ${error}`
            : 'Loading changes…'}
        </div>
      );
    if (total === 0 && files.repos.every((r) => !r.error))
      return (
        <div className="review-empty">
          {scope.kind === 'uncommitted'
            ? 'Nothing uncommitted.'
            : 'No changes since the task started.'}
        </div>
      );
    if (!current) return null;
    if (!content)
      return <div className="review-empty">Loading {current.file.path}…</div>;
    if (content.binary)
      return (
        <div className="review-empty">{`Binary file, ${kb(content.beforeSize)} → ${kb(content.afterSize)}`}</div>
      );
    if (content.tooLarge)
      return (
        <div className="review-empty">{`Too large to show here (${kb(Math.max(content.beforeSize, content.afterSize))}). Open it in your editor.`}</div>
      );
    return (
      <DiffView
        uriKey={`${current.repo.workspaceId}/${current.file.path}`}
        before={content.before ?? ''}
        after={content.after ?? ''}
        // A new file has nothing on the left: inline shows it over the full width.
        sideBySide={prefs.sideBySide && current.file.status !== 'A'}
        ignoreWhitespace={prefs.ignoreWhitespace}
        hideUnchanged={prefs.hideUnchanged}
        onKey={onKey}
        zones={zones}
        onGlyph={
          canComment ? (side, line) => startDraft(side, line) : undefined
        }
        reveal={
          revealHere
            ? {
                side: revealHere.side,
                line: revealHere.line,
                seq: revealHere.seq,
              }
            : undefined
        }
        onRevealed={() => setReveal(undefined)}
        viewStates={viewStatesOf(task.id)}
        onReady={(h) => {
          handle.current = h;
        }}
      />
    );
  };

  return (
    <section
      className="review"
      aria-label="Changes"
      tabIndex={-1}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (
          e.metaKey ||
          e.ctrlKey ||
          e.altKey ||
          t.closest('input, textarea, select, .monaco-editor, [role="menu"]')
        )
          return;
        if (/^[jknpvc0-9]$/.test(e.key)) {
          e.preventDefault();
          onKey(e.key as DiffKey);
        }
      }}
    >
      <div className="review-head">
        <ScopePicker
          scope={scope}
          repos={files?.repos ?? []}
          onChange={(s) => {
            setScope(s);
            if (s.kind === 'commits' && multiRepo)
              filterTo(s.workspaceId, 'commit');
          }}
        />
        {multiRepo && (
          <RepoFilter
            chips={chips}
            value={repoFilter}
            locked={scope.kind === 'commits'}
            onChange={(id) => filterTo(id, 'chip')}
          />
        )}
        <span className="small muted review-progress">
          <span
            className="review-progress-bar"
            role="progressbar"
            aria-label="Viewed"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={viewedCount}
          >
            <span
              style={{
                width: `${total ? (100 * viewedCount) / total : 0}%`,
              }}
            />
          </span>
          {`${viewedCount} / ${total} viewed${repoFilter === null ? '' : ` in ${repoNameOf(repoFilter)}`}`}
        </span>
        {unresolved > 0 && (
          <span className="small muted">{`${unresolved} open ${unresolved === 1 ? 'comment' : 'comments'}`}</span>
        )}
        <span className="grow" />
        <SendComments
          task={task}
          comments={comments}
          multiRepo={multiRepoFiles}
          repoName={repoNameOf}
          onSent={setState}
        />
      </div>
      {scope.kind !== 'all' && (
        <div className="review-note small muted">
          Comments are shown in All changes
        </div>
      )}
      <div className="review-body">
        <div className="review-side">
          <div
            role="tablist"
            aria-label="Review lists"
            className="review-side-tabs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'files'}
              className="pivot"
              onClick={() => setPanel('files')}
            >
              Files
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'comments'}
              className="pivot"
              onClick={() => setPanel('comments')}
            >
              {`Comments (${comments.length})`}
            </button>
            <span className="grow" />
            {panel === 'files' && (
              <span className="review-file-view">
                <button
                  type="button"
                  className="ibtn"
                  aria-pressed={prefs.fileView === 'tree'}
                  aria-label="Show as tree"
                  title="Show as tree"
                  onClick={() => setPref({ fileView: 'tree' })}
                >
                  <TextBulletListTree16Regular aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="ibtn"
                  aria-pressed={prefs.fileView === 'list'}
                  aria-label="Show as list"
                  title="Show as list"
                  onClick={() => setPref({ fileView: 'list' })}
                >
                  <TextBulletListLtr16Regular aria-hidden="true" />
                </button>
              </span>
            )}
          </div>
          {panel === 'files' && pendingDiscard && (
            <ConfirmBar
              message={discardText(pendingDiscard.file)}
              confirmLabel={
                discardKind(pendingDiscard.file) === 'delete'
                  ? 'Delete'
                  : 'Discard'
              }
              busy={discardBusy}
              onConfirm={() => void confirmDiscard()}
              onCancel={() => setDiscarding(null)}
            />
          )}
          {panel === 'files' ? (
            <FileTree
              repos={shownRepos}
              grouped={multiRepo}
              colorOf={(id) => repoColor(task, id)}
              folded={folded}
              dropsAtFinish={(r) =>
                dropsAtFinish({
                  baseKnown: r.base !== null,
                  commits: r.commits.length,
                  uncommitted: r.uncommitted,
                })
              }
              onToggleRepo={(r) => {
                const how = folded(r) ? 'open' : 'closed';
                setFold(r, how);
                if (how === 'closed')
                  track('review.repoCollapsed', { how: 'manual' });
              }}
              view={prefs.fileView}
              selected={selected}
              collapsed={collapsed}
              onToggleDir={(key) =>
                setCollapsed((c) =>
                  c.includes(key) ? c.filter((k) => k !== key) : [...c, key],
                )
              }
              viewed={viewedMap}
              commentCount={(ref) =>
                openCounts.get(viewedKey(ref.workspaceId, ref.path)) ?? 0
              }
              onSelect={pick}
              onViewed={(r, f, on) => void setViewed(r, f, on)}
              onDiscard={canDiscard ? askDiscard : undefined}
            />
          ) : (
            <CommentsList
              comments={comments}
              multiRepo={multiRepoFiles}
              repoName={repoNameOf}
              onOpen={openComment}
              onResolve={resolve}
              onReopen={reopen}
              onDelete={remove}
            />
          )}
        </div>
        <div className="review-main">
          {current && (
            <div className="review-toolbar">
              <span className="mono small review-path">
                {multiRepo && (
                  <>
                    <RepoMark
                      color={repoColor(task, current.repo.workspaceId)}
                      shape="bar"
                    />
                    <button
                      type="button"
                      className="link review-crumb"
                      title={`Show only ${current.repo.name}`}
                      onClick={() =>
                        filterTo(current.repo.workspaceId, 'breadcrumb')
                      }
                    >
                      {current.repo.name}
                    </button>
                    <span className="muted">{' › '}</span>
                  </>
                )}
                {current.file.oldPath
                  ? `${current.file.oldPath} → ${current.file.path}`
                  : current.file.path}
              </span>
              <ViewMenu prefs={prefs} onChange={setPref} />
              <button
                type="button"
                className="btn btn-subtle btn-sm"
                aria-label="Previous change (p)"
                title="Previous change (p)"
                onClick={() => onKey('p')}
              >
                <ArrowUp16Regular />
              </button>
              <button
                type="button"
                className="btn btn-subtle btn-sm"
                aria-label="Next change (n)"
                title="Next change (n)"
                onClick={() => onKey('n')}
              >
                <ArrowDown16Regular />
              </button>
              <span className="review-sep" />
              <button
                type="button"
                className="btn btn-subtle btn-sm"
                aria-label="Previous file"
                title="Previous file (k)"
                onClick={() => onKey('k')}
              >
                <ChevronLeft16Regular />
              </button>
              <button
                type="button"
                className="btn btn-subtle btn-sm"
                aria-label="Next file"
                title="Next file (j)"
                onClick={() => onKey('j')}
              >
                <ChevronRight16Regular />
              </button>
              <span className="review-sep" />
              <button
                type="button"
                className="btn btn-subtle btn-sm"
                aria-label="Open file in editor"
                title="Open file in editor"
                disabled={current.file.status === 'D'}
                onClick={() =>
                  tryInvoke(
                    () =>
                      api().invoke(
                        'editor:openFile',
                        task.id,
                        current.repo.workspaceId,
                        current.file.path,
                        handle.current?.selection()?.startLine,
                      ),
                    notify,
                  )
                }
              >
                <Open16Regular aria-hidden="true" />
                Open file
              </button>
            </div>
          )}
          {outdatedHere.length > 0 && (
            <div className="review-outdated" aria-label="Outdated comments">
              {outdatedHere.map((c) => (
                <div key={c.id}>{card(c)}</div>
              ))}
            </div>
          )}
          {body()}
        </div>
      </div>
    </section>
  );
}

const VIEW_OPTIONS = [
  ['sideBySide', 'Side by side'],
  ['ignoreWhitespace', 'Ignore whitespace'],
  ['hideUnchanged', 'Hide unchanged'],
] as const;

/** The diff's display options, folded into one menu: they are set once and seldom changed. */
function ViewMenu({
  prefs,
  onChange,
}: {
  prefs: Pick<ReviewPrefs, (typeof VIEW_OPTIONS)[number][0]>;
  onChange: (p: Partial<ReviewPrefs>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className="btn btn-subtle btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        View
        <ChevronDown16Regular aria-hidden="true" />
      </button>
      <PopupMenu label="View" anchor={anchor} open={open} onClose={close}>
        {VIEW_OPTIONS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="menuitemcheckbox"
            aria-checked={prefs[key]}
            className="menu-item review-view-item"
            onClick={() => onChange({ [key]: !prefs[key] })}
          >
            <span className="menu-title">
              <span className="review-view-check" aria-hidden="true">
                {prefs[key] ? '✓' : ''}
              </span>
              {label}
            </span>
          </button>
        ))}
      </PopupMenu>
    </>
  );
}
