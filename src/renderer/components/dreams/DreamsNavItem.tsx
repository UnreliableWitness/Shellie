import { WeatherMoon20Regular } from '@fluentui/react-icons';
import { useMemo } from 'react';
import { useContributeCommands } from '../../commands/registry';
import type { Command } from '../../commands/types';
import { plural } from '../../format';
import { useStore } from '../../store';
import { waitingCount } from './dreamWords';
import { useDreamsState } from './useDreams';

/**
 * The Dreams item in the navigation, with the number of dream results waiting for review (a result opened as a task
 * whose task is not made yet counts). Always shown.
 */
export function DreamsNavItem({ rail }: { rail: boolean }) {
  const kind = useStore((s) => s.screen.kind);
  const go = useStore((s) => s.go);
  const { view, project } = useDreamsState();
  const count = view ? waitingCount(view) : 0;
  const waiting = `${plural(count, 'dream')} to review`;
  const named = count > 0 ? `Dreams, ${waiting}` : 'Dreams';
  // Also a place the palette can go to, with what waits there.
  const shows = project !== null;
  const commands = useMemo<Command[]>(
    () =>
      shows
        ? [
            {
              id: 'goto.dreams',
              title: 'Dreams',
              group: 'goto',
              ...(count > 0
                ? { note: `${count} to review`, noteTone: 'accent' as const }
                : {}),
              run: () => go({ kind: 'dreams' }),
            },
          ]
        : [],
    [shows, count, go],
  );
  useContributeCommands('nav.dreams', commands);
  // Dreams belong to a project: without one there is nothing to open.
  if (!shows) return null;
  return (
    <button
      type="button"
      className="navitem"
      aria-current={
        kind === 'dreams' || kind === 'dream' || kind === 'dream-setup'
          ? 'page'
          : undefined
      }
      aria-label={rail ? named : undefined}
      title={rail ? named : undefined}
      onClick={() => go({ kind: 'dreams' })}
    >
      <WeatherMoon20Regular aria-hidden="true" />
      {!rail && <span>Dreams</span>}
      {count > 0 && (
        <span
          className="navitem-count"
          role={rail ? undefined : 'img'}
          aria-label={rail ? undefined : waiting}
          aria-hidden={rail ? 'true' : undefined}
        >
          {count}
        </span>
      )}
    </button>
  );
}
