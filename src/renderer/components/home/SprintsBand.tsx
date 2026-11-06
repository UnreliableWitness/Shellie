import { useEffect, useState } from 'react';
import type {
  HomeConnection,
  HomeSnapshot,
  HomeSprint,
} from '../../../shared/home';
import { progress } from '../../../shared/sprintTime';
import { formatDuration, type LocalItemTime } from '../../../shared/time';
import { api } from '../../api';
import { connectionNote, sprintTotals } from '../../homeView';
import { useStore } from '../../store';
import { track } from '../../telemetry';
import { stateMeta, useWorkItemTypes } from '../../workItemTypes';
import { TimeBar } from '../ui';
import { Band } from './Band';

const REFETCH_MS = 5_000;

export const daysLeft = (finish: string | null): string | null => {
  if (!finish) return null;
  const days = Math.ceil((Date.parse(finish) - Date.now()) / 86_400_000);
  return days <= 0
    ? 'Ends today'
    : days === 1
      ? '1 day left'
      : `${days} days left`;
};

function SprintCard({
  connection,
  sprint,
  local,
}: {
  connection: HomeConnection;
  sprint: HomeSprint;
  local: Record<string, LocalItemTime>;
}) {
  const setConnectionId = useStore((s) => s.setConnectionId);
  const go = useStore((s) => s.go);
  const types = useWorkItemTypes(
    (s) => s.byConnection[connection.connectionId],
  );
  const t = sprintTotals(sprint, local, (type, state) =>
    types?.status === 'ok'
      ? stateMeta(types.types.get(type.toLowerCase()), state)?.category
      : undefined,
  );
  const { pct, over } = progress(t.spentSeconds, t.estimateHours);
  const left = daysLeft(sprint.finishDate);
  return (
    <button
      type="button"
      className={
        connection.status === 'ok' ? 'home-card' : 'home-card is-stale-data'
      }
      aria-label={`${connection.name}/${connection.project}, ${sprint.name}, ${left ? `${left}, ` : ''}${t.todo} to do, ${t.doing} in progress, ${t.done} done, ${formatDuration(t.spentSeconds)}${t.estimateHours !== null ? ` of ${formatDuration(t.estimateHours * 3600)}` : ''}`}
      onClick={() => {
        track('home.clicked', { band: 'sprint' });
        setConnectionId(connection.connectionId);
        go({ kind: 'sprint' });
      }}
    >
      <span className="home-card-title">
        {connection.name}/{connection.project} · {sprint.name}
      </span>
      <span className="muted small">
        {left && `${left} · `}
        {t.todo} to do · {t.doing} in progress · {t.done} done
      </span>
      <span className="small">
        {formatDuration(t.spentSeconds)}
        {t.estimateHours !== null &&
          ` / ${formatDuration(t.estimateHours * 3600)}`}
      </span>
      {pct !== null && <TimeBar pct={pct} over={over} />}
    </button>
  );
}

export function SprintsBand({ snapshot }: { snapshot: HomeSnapshot | null }) {
  const repos = useStore((s) => s.repos);
  const connections = snapshot?.connections ?? [];
  const [local, setLocal] = useState<
    Record<string, Record<string, LocalItemTime>>
  >({});
  const ids = connections
    .filter((c) => c.sprints.length > 0)
    .map((c) => c.connectionId)
    .join(',');
  const builtAt = snapshot?.builtAt;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      for (const id of ids ? ids.split(',') : [])
        api()
          .invoke('time:sprint', id)
          .then((t) => live && setLocal((l) => ({ ...l, [id]: t })))
          .catch(() => undefined);
    };
    // Time changes arrive every few seconds while the clock runs; refetch at most this often.
    const later = () => {
      timer ??= setTimeout(() => {
        timer = null;
        load();
      }, REFETCH_MS);
    };
    load();
    const off = api().on('time:changed', later);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [ids, builtAt]);
  const linked = new Set(
    repos.filter((r) => !r.discovered).map((r) => r.connectionId),
  );
  const cards = connections.flatMap((c) =>
    c.sprints.map((s) => (
      <SprintCard
        key={`${c.connectionId}:${s.iterationId}`}
        connection={c}
        sprint={s}
        local={local[c.connectionId] ?? {}}
      />
    )),
  );
  const empty = connections.filter(
    (c) =>
      c.status === 'ok' &&
      c.sprints.length === 0 &&
      !c.sprintsError &&
      linked.has(c.connectionId),
  );
  const notes = connections.flatMap((c) => {
    const note = connectionNote(c);
    return note ? [{ id: c.connectionId, note }] : [];
  });
  return (
    <Band title="My sprints">
      <div className="home-cards">
        {cards}
        {empty.map((c) => (
          <div key={c.connectionId} className="home-card is-slim muted">
            {c.name}/{c.project}: nothing assigned
          </div>
        ))}
      </div>
      {cards.length === 0 &&
        empty.length === 0 &&
        notes.length === 0 &&
        !connections.some((c) => c.sprintsError) && (
          <p className="muted">Nothing assigned to you in a current sprint.</p>
        )}
      {notes.map((n) => (
        <p key={n.id} className="muted small">
          {n.note}
        </p>
      ))}
      {connections
        .filter((c) => c.sprintsError)
        .map((c) => (
          <p key={c.connectionId} className="muted small">
            Couldn't load sprints for {c.name}/{c.project}
          </p>
        ))}
    </Band>
  );
}
