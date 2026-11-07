import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrainView } from '../../shared/brain';
import { api } from '../api';

/** Bursts of `brain:changed` (a capture writes many files) collapse into one refetch. */
const DEBOUNCE_MS = 200;

/** Calls `run` (debounced) when the brain `brainId` changes, or any brain when it is null. */
export function useBrainChanged(brainId: string | null, run: () => void): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api().on('brain:changed', (e) => {
      if (brainId !== null && e.brainId !== brainId) return;
      clearTimeout(timer);
      timer = setTimeout(() => latest.current(), DEBOUNCE_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [brainId]);
}

/** Every brain, fetched on mount and again when one changes; `loaded` once the first answer came. */
function useBrainList(): { brains: BrainView[]; loaded: boolean } {
  const [list, setList] = useState({
    brains: [] as BrainView[],
    loaded: false,
  });
  const load = useCallback(() => {
    api()
      .invoke('brain:list')
      // A failed answer keeps what was shown but still counts as loaded.
      .then(
        (brains) => setList({ brains, loaded: true }),
        () => setList((l) => ({ ...l, loaded: true })),
      );
  }, []);
  useEffect(load, [load]);
  useBrainChanged(null, load);
  return list;
}

/** Every brain, fetched on mount and again when one changes. */
export function useBrains(): BrainView[] {
  return useBrainList().brains;
}

/** The brains that are not archived, and whether `brain:list` has answered yet. */
export function useActiveBrainsLoaded(): {
  brains: BrainView[];
  loaded: boolean;
} {
  const { brains, loaded } = useBrainList();
  const active = useMemo(() => brains.filter((b) => !b.archived), [brains]);
  return { brains: active, loaded };
}

/** The brains that are not archived: what "the project has a brain" means in the first-run steps. */
export function useActiveBrains(): BrainView[] {
  return useActiveBrainsLoaded().brains;
}

/** One brain, fetched on mount and again when it changes; null until loaded or when it is gone. */
export function useBrain(brainId: string): BrainView | null {
  const [brain, setBrain] = useState<BrainView | null>(null);
  const load = useCallback(() => {
    api()
      .invoke('brain:get', brainId)
      .then(setBrain, () => setBrain(null));
  }, [brainId]);
  useEffect(load, [load]);
  useBrainChanged(brainId, load);
  return brain;
}

/** The brain of a task's project, null when it has none; fetched on mount and again when that brain changes. */
export function useTaskBrain(taskId: string): BrainView | null {
  const [brain, setBrain] = useState<BrainView | null>(null);
  const load = useCallback(() => {
    api()
      .invoke('brain:forTask', taskId)
      // A failed refetch keeps what was shown; only a successful answer (null: no brain) clears it.
      .then(setBrain, () => undefined);
  }, [taskId]);
  useEffect(load, [load]);
  useBrainChanged(brain?.id ?? null, load);
  return brain;
}
