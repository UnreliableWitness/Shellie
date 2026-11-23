import { useMemo } from 'react';
import { useContributeCommands } from '../commands/registry';
import type { BrainView } from '../../shared/brain';
import type { Command } from '../commands/types';
import { useBrains } from '../hooks/useBrains';
import { useReading, useReadingNudges } from '../hooks/useReadingFeed';
import { hasEvent } from '../readingFeed';
import { activeConnection, useStore } from '../store';
import { waitingCount } from './dreams/dreamWords';
import { useDreamsState } from './dreams/useDreams';

/**
 * Offers the places the palette can go to that the store alone does not know: the active project's brains and
 * Dreams, each with what waits there. The caller passes the brains and which have something to read, so the nav,
 * which already holds both, asks main for nothing twice.
 */
export function usePlaceCommands(
  brains: Pick<BrainView, 'id' | 'name'>[],
  toRead: Set<string>,
): void {
  const go = useStore((s) => s.go);
  const { view, project } = useDreamsState();
  const dreams = project !== null;
  const waiting = view ? waitingCount(view) : 0;
  const brainKey = brains
    .map((b) => `${b.id}\n${b.name}\n${toRead.has(b.id) ? 1 : 0}`)
    .join('\n');
  const commands = useMemo<Command[]>(
    () => [
      ...(dreams
        ? [
            {
              id: 'goto.dreams',
              title: 'Dreams',
              group: 'goto' as const,
              ...(waiting > 0
                ? { note: `${waiting} to review`, noteTone: 'accent' as const }
                : {}),
              run: () => go({ kind: 'dreams' }),
            },
          ]
        : []),
      ...brains.map((brain, i): Command => ({
        id: `goto.brain.${i}`,
        title: `Brain: ${brain.name}`,
        group: 'goto',
        ...(toRead.has(brain.id)
          ? { note: 'something to read', noteTone: 'accent' as const }
          : {}),
        run: () => go({ kind: 'brain', brainId: brain.id }),
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- brainKey stands for the brains and what waits in them
    [brainKey, dreams, waiting, go],
  );
  useContributeCommands('places', commands);
}

/**
 * The same places when the nav is not on screen (Focus): the nav offers them itself while it is, so this is
 * mounted only without it. Renders nothing.
 */
export function PlaceCommands() {
  const connection = useStore(activeConnection);
  // Like the nav: only the active project's brains (#229), none without a connection.
  const brains = useBrains().filter(
    (b) => b.connectionId === connection?.id && !b.archived,
  );
  const nudges = useReadingNudges();
  const reading = useReading();
  // The nav's dot rule: an event (a long read for your work, a change in one you read), never the unread pile.
  const toRead = new Set(
    nudges ? reading.filter(hasEvent).map((r) => r.brain.brainId) : [],
  );
  usePlaceCommands(brains, toRead);
  return null;
}
