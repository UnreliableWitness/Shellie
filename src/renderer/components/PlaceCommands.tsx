import { useMemo } from 'react';
import { BRAIN_SHORTCUT, DREAMS_SHORTCUT } from '../commands/global';
import {
  useContributeCommands,
  useContributedWith,
} from '../commands/registry';
import type { BrainView } from '../../shared/brain';
import type { Command } from '../commands/types';
import { useProjectBrains } from '../hooks/useProjectBrains';
import { useStore } from '../store';
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
  // A task with a Brain tab has the brain's key for that tab; the place shows no key it would not get.
  const taskHasKey = useContributedWith('task.brain').length > 0;
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
              shortcut: DREAMS_SHORTCUT,
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
        // The first brain has the key: a project seldom has a second.
        ...(i === 0 && !taskHasKey ? { shortcut: BRAIN_SHORTCUT } : {}),
        ...(toRead.has(brain.id)
          ? { note: 'something to read', noteTone: 'accent' as const }
          : {}),
        run: () => go({ kind: 'brain', brainId: brain.id }),
      })),
      ...brains.map((brain, i): Command => ({
        id: `goto.brain.explore.${i}`,
        title: `Explore ${brain.name}`,
        group: 'goto',
        run: () => go({ kind: 'brain', brainId: brain.id, focus: 'explore' }),
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- brainKey stands for the brains and what waits in them
    [brainKey, dreams, waiting, taskHasKey, go],
  );
  useContributeCommands('places', commands);
}

/**
 * The same places when the nav is not on screen (Focus): the nav offers them itself while it is, so this is
 * mounted only without it. Renders nothing.
 */
export function PlaceCommands() {
  const { brains, toRead } = useProjectBrains();
  usePlaceCommands(brains, toRead);
  return null;
}
