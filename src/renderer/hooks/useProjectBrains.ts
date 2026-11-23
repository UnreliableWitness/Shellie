import { useMemo } from 'react';
import type { BrainView } from '../../shared/brain';
import { hasEvent } from '../readingFeed';
import { activeConnection, useStore } from '../store';
import { useBrains } from './useBrains';
import { useReading, useReadingNudges } from './useReadingFeed';

/**
 * The active project's brains (#229: none without a connection, none archived) and which of them have something to
 * read: an event (a long read for your work, a change in one you read), never the pile of unread ones, and nothing
 * while reading nudges are off. One rule for the nav's For you line, the palette's places and Home's tiles.
 */
export function useProjectBrains(): {
  brains: BrainView[];
  toRead: Set<string>;
} {
  const connectionId = useStore((s) => activeConnection(s)?.id);
  const all = useBrains();
  const nudges = useReadingNudges();
  const reading = useReading();
  return useMemo(
    () => ({
      brains: all.filter((b) => b.connectionId === connectionId && !b.archived),
      toRead: new Set(
        nudges ? reading.filter(hasEvent).map((r) => r.brain.brainId) : [],
      ),
    }),
    [all, connectionId, nudges, reading],
  );
}
