import { WeatherMoon20Regular } from '@fluentui/react-icons';
import { plural } from '../../format';
import { useStore } from '../../store';
import { openResults } from './dreamWords';
import { useDreams } from './useDreams';

/** The Dreams item in the navigation, with the number of dream results waiting for review. Always shown. */
export function DreamsNavItem({ rail }: { rail: boolean }) {
  const kind = useStore((s) => s.screen.kind);
  const go = useStore((s) => s.go);
  const view = useDreams();
  const count = view ? openResults(view).length : 0;
  const waiting = `${plural(count, 'dream')} to review`;
  const named = count > 0 ? `Dreams, ${waiting}` : 'Dreams';
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
