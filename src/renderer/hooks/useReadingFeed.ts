import { useEffect, useMemo } from 'react';
import { mergeMarks } from '../../shared/reader';
import type { ReadingUpNext } from '../../shared/reading';
import { api } from '../api';
import { loadMarks } from '../components/brain/longReads';
import {
  freshNudge,
  readingOf,
  workKey,
  type BrainReading,
} from '../readingFeed';
import { useStore } from '../store';
import { track } from '../telemetry';

/** Events come in bursts (a build's jobs, a push's marks): one fetch a moment after the last. */
const SETTLE_MS = 1500;

let again: () => void = () => {};
/** Fetches the reading list again a moment from now: for a mark the Read view just set. */
export const refreshReading = () => again();

/**
 * Keeps the reading list of every brain in the store: fetched at launch and again when a brain's files, a mark,
 * Home's snapshot or the open tasks' work items change. What a fetch brings that is news becomes the notice
 * (`readingNudge`), unless the nudges are off.
 */
export function useReadingFeed(): void {
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let seen: Set<string> | null = null;
    const load = () =>
      api()
        .invoke('reading:get')
        .then((brains) => {
          if (!live) return;
          // A mark set a moment ago may be here and not yet in main's answer.
          const reading = brains.map((b) => ({
            ...b,
            marks: mergeMarks(loadMarks(b.brainId), b.marks),
          }));
          const news = freshNudge(seen, reading);
          seen = news.seen;
          const store = useStore.getState();
          store.setReading(reading);
          if (news.nudge && store.settings?.readingNudges !== false) {
            store.setReadingNudge(news.nudge);
            track('reading.nudge', { kind: news.nudge.kind });
          }
        })
        .catch(() => undefined);
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), SETTLE_MS);
    };
    again = soon;
    void load();
    let work = workKey(useStore.getState().tasks);
    const offStore = useStore.subscribe((s) => {
      const now = workKey(s.tasks);
      if (now === work) return;
      work = now;
      soon();
    });
    const offs = [
      api().on('brain:changed', soon),
      api().on('reader:marksChanged', soon),
      api().on('home:updated', soon),
    ];
    return () => {
      live = false;
      again = () => {};
      if (timer) clearTimeout(timer);
      offStore();
      offs.forEach((off) => off());
    };
  }, []);
}

/** Whether the reading nudges are on (Settings › User › Appearance); on until the settings say otherwise. */
export const useReadingNudges = () =>
  useStore((s) => s.settings?.readingNudges !== false);

/** Every brain's reading list, as the store has it. */
export function useReading(): BrainReading[] {
  const reading = useStore((s) => s.reading);
  return useMemo(() => reading.map(readingOf), [reading]);
}

export type OpenFrom = 'home' | 'notice' | 'task' | 'list';
export type OpenWhy = ReadingUpNext['why'] | 'foundations' | 'later';

/** A piece opened from the reading list or one of its nudges: where from, why it was listed, and what it is. */
export const trackPieceOpen = (
  from: OpenFrom,
  why: OpenWhy,
  kind: 'read' | 'letter',
) => track('reading.open', { from, why, kind });

/** Opens a piece in its brain's Read view, from anywhere in the app. */
export function openPiece(
  brainId: string,
  path: string,
  from: OpenFrom,
  why: OpenWhy,
  kind: 'read' | 'letter',
): void {
  trackPieceOpen(from, why, kind);
  useStore.getState().openInBrain(brainId, path);
}
