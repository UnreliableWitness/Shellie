import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ReviewFiles,
  ReviewScope,
  ReviewState,
} from '../../shared/review';
import type { TaskView } from '../../shared/types';
import {
  activeWorkspaces,
  docsTarget,
  HOME_ID,
  parseDocsTarget,
} from '../../shared/workspaces';
import { api } from '../api';
import { errorMessage } from '../../shared/errors';
import { holdWatch } from './holdWatch';

const POLL_MS = 5000;
const SETTLE_MS = 200;

/** The home repo shares the Docs tab's watcher key (the task id); other repos use `<taskId>#<workspaceId>`. */
const reviewTarget = (taskId: string, workspaceId: string): string =>
  workspaceId === HOME_ID ? taskId : docsTarget(taskId, workspaceId);

/** The task's repos as one string: a repo joining or leaving changes it. */
const workspaceIds = (task: TaskView): string =>
  activeWorkspaces(task)
    .map((w) => w.id)
    .join(',');

/** Follows the task's worktrees (files and git dirs) while `visible`; polls when a watcher is not live. */
function useWorktreeChanges(
  task: TaskView,
  visible: boolean,
  onChange: () => void,
) {
  const latest = useRef(onChange);
  latest.current = onChange;
  const ids = workspaceIds(task);
  useEffect(() => {
    if (!visible || task.status !== 'ready' || task.worktreeMissing) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Trailing: a burst of events refreshes once, SETTLE_MS after the last one.
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        latest.current();
      }, SETTLE_MS);
    };
    const mine = (target: string) => parseDocsTarget(target).taskId === task.id;
    const offs = [
      api().on('docs:changed', (p) => mine(p.taskId) && soon()),
      api().on('review:changed', (p) => mine(p.taskId) && soon()),
    ];
    let poll: ReturnType<typeof setInterval> | null = null;
    const releases = ids
      .split(',')
      .filter(Boolean)
      .map((id) =>
        holdWatch('review:watch', reviewTarget(task.id, id), (live) => {
          if (!live && !poll)
            poll = setInterval(() => latest.current(), POLL_MS);
        }),
      );
    return () => {
      for (const off of offs) off();
      for (const r of releases) r();
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
    };
  }, [task.id, task.status, task.worktreeMissing, visible, ids]);
}

/**
 * Runs the latest `load` at most once at a time: a call while one runs marks it dirty, and the
 * running load is followed by exactly one more.
 */
function useSerialRefresh(load: () => Promise<unknown>): () => void {
  const latest = useRef(load);
  latest.current = load;
  const running = useRef(false);
  const dirty = useRef(false);
  return useCallback(() => {
    const run = () => {
      running.current = true;
      void latest
        .current()
        .catch(() => undefined)
        .finally(() => {
          running.current = false;
          if (dirty.current) {
            dirty.current = false;
            run();
          }
        });
    };
    if (running.current) dirty.current = true;
    else run();
  }, []);
}

export function useReview(
  task: TaskView,
  scope: ReviewScope,
  visible: boolean,
) {
  const [files, setFiles] = useState<ReviewFiles | null>(null);
  const [state, setState] = useState<ReviewState | null>(null);
  const [changedAt, setChangedAt] = useState(0);
  // Why the last load failed; cleared by the next one that works.
  const [error, setError] = useState<string | null>(null);
  const key = `${task.id}|${JSON.stringify(scope)}`;
  const latestKey = useRef(key);
  latestKey.current = key;

  const refresh = useSerialRefresh(async () => {
    const asked = key;
    let f: ReviewFiles;
    let s: ReviewState;
    try {
      [f, s] = await Promise.all([
        api().invoke('review:files', task.id, scope),
        api().invoke('review:state', task.id),
      ]);
    } catch (e) {
      if (asked === latestKey.current) setError(errorMessage(e));
      return;
    }
    // An answer for an older task or scope is dropped (the scope change queued a fresh load).
    if (asked !== latestKey.current) return;
    setFiles(f);
    setState(s);
    setError(null);
    setChangedAt((x) => x + 1);
  });

  // A repo that joins the task (#84) or leaves it is loaded or dropped at once, not at its next change.
  const ids = workspaceIds(task);
  useEffect(() => {
    if (visible) refresh();
  }, [visible, key, ids, refresh]);
  useWorktreeChanges(task, visible, refresh);

  return { files, state, setState, refresh, changedAt, error };
}

/** The number of files in All changes, for the pivot's badge; keeps its last count while not `enabled`. */
export function useChangeCount(
  task: TaskView,
  enabled: boolean,
): number | null {
  const [count, setCount] = useState<number | null>(null);
  const seq = useRef(0);
  const refresh = useSerialRefresh(async () => {
    const n = ++seq.current;
    try {
      const f = await api().invoke('review:files', task.id, { kind: 'all' });
      if (n === seq.current)
        setCount(f.repos.reduce((x, r) => x + r.files.length, 0));
    } catch {
      if (n === seq.current) setCount(null);
    }
  });
  useEffect(() => {
    // A newer task drops any answer still on its way for the previous one.
    seq.current++;
  }, [task.id]);
  const ids = workspaceIds(task);
  useEffect(() => {
    if (enabled && task.status === 'ready' && !task.worktreeMissing) refresh();
  }, [enabled, task.id, task.status, task.worktreeMissing, ids, refresh]);
  useWorktreeChanges(task, enabled, refresh);
  return count;
}
