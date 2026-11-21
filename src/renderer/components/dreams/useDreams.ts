import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { DreamView } from '../../../shared/dreams';
import { api } from '../../api';
import { activeConnection, useStore } from '../../store';

/** Bursts of `dream:changed` collapse into one refetch. */
const DEBOUNCE_MS = 100;

type State = { view: DreamView | null; failed: boolean };
const EMPTY: State = { view: null, failed: false };

/**
 * Dreams belong to a project (a connection): one view per project for every mounted consumer of it (navigation,
 * Home, the Dreams screens, Settings), with one `dream:get` per change however many components show it. A project's
 * view is dropped when its last consumer unmounts, so nothing of it lingers after the active project changes.
 */
type Entry = {
  state: State;
  subs: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped when the last consumer leaves: an answer from before is dropped. */
  gen: number;
  asked: number;
  shown: number;
  loading: number;
};
const entries = new Map<string, Entry>();
/** The one `dream:changed` listener, while any project has a consumer. */
let off: (() => void) | null = null;

const entryOf = (project: string): Entry => {
  let e = entries.get(project);
  if (!e) {
    e = {
      state: EMPTY,
      subs: new Set(),
      timer: undefined,
      gen: 0,
      asked: 0,
      shown: 0,
      loading: 0,
    };
    entries.set(project, e);
  }
  return e;
};

const set = (e: Entry, next: State) => {
  e.state = next;
  for (const f of e.subs) f();
};

const load = (project: string) => {
  const e = entryOf(project);
  const g = e.gen;
  const n = ++e.asked;
  e.loading++;
  api()
    .invoke('dream:get', project)
    .then(
      (view) => {
        // An answer older than one already shown is ignored.
        if (g !== e.gen || n < e.shown) return;
        e.shown = n;
        set(e, { view, failed: false });
      },
      () => {
        // A failed refetch keeps what was shown; a failed first load says so.
        if (g === e.gen && !e.state.view) set(e, { view: null, failed: true });
      },
    )
    .finally(() => {
      if (g === e.gen) e.loading--;
    });
};

const subscribeTo =
  (project: string) =>
  (fn: () => void): (() => void) => {
    const e = entryOf(project);
    e.subs.add(fn);
    off ??= api().on('dream:changed', () => {
      for (const [id, x] of entries) {
        if (x.subs.size === 0) continue;
        clearTimeout(x.timer);
        // Always a new fetch: one under way may answer with a view from before the change.
        x.timer = setTimeout(() => load(id), DEBOUNCE_MS);
      }
    });
    // A screen that mounts shows fresh numbers; screens that mount together share one call.
    if (e.loading === 0) load(project);
    return () => {
      e.subs.delete(fn);
      if (e.subs.size > 0) return;
      clearTimeout(e.timer);
      e.gen++;
      entries.delete(project);
      if (entries.size === 0) {
        off?.();
        off = null;
      }
    };
  };

const noProject = (): (() => void) => () => undefined;
const empty = (): State => EMPTY;

/** The project the shell shows: the one whose dreams every screen but Settings shows. */
export const useDreamProject = (): string | null =>
  useStore((s) => activeConnection(s)?.id ?? null);

/**
 * Everything the Dreams screens show for one project: the active one, or `of` (Settings shows the project picked
 * there). Fetched on mount and again on `dream:changed`. `view` is null while loading, when the first load failed
 * (`failed`), and when there is no project; `retry` loads again. `project` is the one the view is of.
 */
export function useDreamsState(of?: string): {
  view: DreamView | null;
  failed: boolean;
  retry: () => void;
  project: string | null;
} {
  const active = useDreamProject();
  const project = of ?? active;
  const subscribe = useMemo(
    () => (project === null ? noProject : subscribeTo(project)),
    [project],
  );
  const current = useCallback(
    () => (project === null ? EMPTY : (entries.get(project)?.state ?? EMPTY)),
    [project],
  );
  const s = useSyncExternalStore(subscribe, project === null ? empty : current);
  const retry = useCallback(() => {
    if (project === null) return;
    set(entryOf(project), EMPTY);
    load(project);
  }, [project]);
  return { ...s, retry, project };
}

/** The view alone; null while loading, when it could not be loaded, or without a project. */
export function useDreams(of?: string): DreamView | null {
  return useDreamsState(of).view;
}
