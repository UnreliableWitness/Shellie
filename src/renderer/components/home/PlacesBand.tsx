import type { ReactNode } from 'react';
import { eur, plural } from '../../format';
import { useHomeStats } from '../../hooks/useHomeStats';
import { useProjectBrains } from '../../hooks/useProjectBrains';
import { activeConnection, useStore } from '../../store';
import { track } from '../../telemetry';
import { navLine, waitingCount } from '../dreams/dreamWords';
import { useDreamsState } from '../dreams/useDreams';
import { Band } from './Band';

function Place({
  name,
  line,
  waits = false,
  onClick,
}: {
  name: string;
  /** One line of state; nothing while it is not known. */
  line?: ReactNode;
  /** The line says something waits for the user. */
  waits?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="home-place" onClick={onClick}>
      <b>{name}</b>
      <span className={waits ? 'small home-place-waits' : 'small muted'}>
        {line}
      </span>
    </button>
  );
}

/**
 * Home's Places: one tile per destination the nav no longer lists (Sprint, Week, Dreams, the active project's
 * brains) and the month's AI cost, each with one line of state. A tile is a button and nothing else.
 */
export function PlacesBand() {
  const go = useStore((s) => s.go);
  const connection = useStore(activeConnection);
  const several = useStore((s) => s.connections.length > 1);
  const sprint = useStore((s) =>
    connection ? s.sprints[connection.id]?.sprint.iteration?.name : undefined,
  );
  const { brains, toRead } = useProjectBrains();
  const { view, project } = useDreamsState();
  const waiting = view ? waitingCount(view) : 0;
  const month = useHomeStats('month');
  const open = (place: string, to: () => void) => () => {
    track('home.clicked', { band: `place-${place}` });
    to();
  };
  return (
    <Band
      title="Places"
      aside={
        several &&
        connection && (
          <span className="muted small">{`${connection.name}/${connection.project}`}</span>
        )
      }
    >
      <div className="home-places">
        <Place
          name="Sprint"
          line={sprint}
          onClick={open('sprint', () => go({ kind: 'sprint' }))}
        />
        <Place
          name="Week"
          line="Time per task"
          onClick={open('week', () => go({ kind: 'week' }))}
        />
        {project !== null && (
          <Place
            name="Dreams"
            line={
              waiting > 0
                ? `${plural(waiting, 'dream')} to review`
                : view && navLine(view).line
            }
            waits={waiting > 0}
            onClick={open('dreams', () => go({ kind: 'dreams' }))}
          />
        )}
        {brains.map((b) => (
          <Place
            key={b.id}
            name={b.name}
            line={toRead.has(b.id) ? 'Something to read' : 'Brain'}
            waits={toRead.has(b.id)}
            onClick={open('brain', () => go({ kind: 'brain', brainId: b.id }))}
          />
        ))}
        <Place
          name="Cost"
          // Billable usage in Shellie's tasks only; the budget bands count the whole month, outside Shellie too.
          line={month && `${eur(month.costEur)} in tasks this month`}
          onClick={open('cost', () =>
            document
              .querySelector('[aria-label="Stats"]')
              ?.scrollIntoView?.({ block: 'start' }),
          )}
        />
      </div>
    </Band>
  );
}

/** The quiet links at the foot of Home: the pages that need no tile. */
export function MoreLinks() {
  const go = useStore((s) => s.go);
  const connection = useStore(activeConnection);
  return (
    <nav aria-label="More places" className="home-more">
      {connection && (
        <button
          type="button"
          onClick={() => {
            go({ kind: 'project' });
            track('project.open', { from: 'home' });
          }}
        >
          Project
        </button>
      )}
      <button type="button" onClick={() => go({ kind: 'settings' })}>
        Settings
      </button>
      <button type="button" onClick={() => go({ kind: 'secrets' })}>
        Secrets
      </button>
      <button type="button" onClick={() => go({ kind: 'get-started' })}>
        Get started
      </button>
    </nav>
  );
}
