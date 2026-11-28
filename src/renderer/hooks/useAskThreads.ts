import { useEffect } from 'react';
import { api } from '../api';
import { askThreadsToSave, useStore } from '../store';

/** How long the threads rest after a change before they are saved. */
const SAVE_AFTER_MS = 500;

/**
 * Keeps what was asked of the brains over a restart: reads the threads main kept once at the start, then saves
 * them whenever they change. Nothing is saved before that read came back, or when it failed, so a file Shellie
 * could not read is never written over by an empty one.
 */
export function useAskThreads(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let off: (() => void) | undefined;
    let gone = false;
    const save = () =>
      void api()
        .invoke('brainAsk:save', askThreadsToSave(useStore.getState()))
        .catch((e: unknown) =>
          console.warn('[brain] the questions could not be saved', e),
        );
    void api()
      .invoke('brainAsk:load')
      .then((threads) => {
        if (gone) return;
        useStore.getState().loadBrainThreads(threads);
        off = useStore.subscribe((s, prev) => {
          if (
            s.brainAsksByTask === prev.brainAsksByTask &&
            s.brainAskThread === prev.brainAskThread &&
            s.brainAskEarlier === prev.brainAskEarlier
          )
            return;
          clearTimeout(timer);
          timer = setTimeout(save, SAVE_AFTER_MS);
        });
      })
      .catch((e: unknown) =>
        console.warn('[brain] the kept questions could not be read', e),
      );
    return () => {
      gone = true;
      off?.();
      // A change still waiting is saved now, not lost.
      if (timer !== undefined) {
        clearTimeout(timer);
        save();
      }
    };
  }, []);
}
