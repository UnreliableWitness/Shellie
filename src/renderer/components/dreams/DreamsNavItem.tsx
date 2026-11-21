import { WeatherMoon20Regular } from '@fluentui/react-icons';
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
  // Dreams belong to a project: without one there is nothing to open.
  if (project === null) return null;
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
