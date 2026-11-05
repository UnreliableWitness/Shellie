import { useEffect, useMemo, useState } from 'react';
import type { BrainView } from '../../../shared/brain';
import { projectTasks } from '../../../shared/projectGraph';
import type { Connection } from '../../../shared/types';
import { api } from '../../api';
import { Band } from '../../components/home/Band';
import { ago, eur, plural } from '../../format';
import { useBrains } from '../../hooks/useBrains';
import { useStore } from '../../store';

const RECENT = 3;

type Counts = { pages: number | null; sources: number | null };

/** Page and source counts per brain: `brain:list` has none, so one `brain:get` and `brain:sources` each. */
function useCounts(brains: BrainView[]): Record<string, Counts> {
  const [counts, setCounts] = useState<Record<string, Counts>>({});
  const key = brains.map((b) => b.id).join(',');
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(',') : []) {
      const put = (part: Partial<Counts>) =>
        live &&
        setCounts((c) => ({
          ...c,
          [id]: { ...(c[id] ?? { pages: null, sources: null }), ...part },
        }));
      api()
        .invoke('brain:get', id)
        .then((b) => put({ pages: b.health?.pages ?? null }))
        .catch(() => undefined);
      api()
        .invoke('brain:sources', id)
        .then((rows) => put({ sources: rows.length }))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [key]);
  return counts;
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** The project's brains with their entry points, and the last tasks it finished. */
export function BrainsBand({ connection }: { connection: Connection }) {
  const id = connection.id;
  const go = useStore((s) => s.go);
  const openTask = useStore((s) => s.openTask);
  const tasks = useStore((s) => s.tasks);
  const repos = useStore((s) => s.repos);
  const all = useBrains();
  const brains = useMemo(
    () => all.filter((b) => b.connectionId === id && !b.archived),
    [all, id],
  );
  const counts = useCounts(brains);
  const manage = () =>
    go({
      kind: 'settings',
      scope: 'project',
      connectionId: id,
      section: 'project-brains',
    });

  const finished = useMemo(
    () =>
      projectTasks(tasks, repos, id, new Date())
        .filter((t) => t.status === 'done' && t.finishedAt !== null)
        .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
        .slice(0, RECENT),
    [tasks, repos, id],
  );
  const finishedKey = finished.map((t) => t.id).join(',');
  const [costs, setCosts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!finishedKey) return;
    let live = true;
    api()
      .invoke('usage:costs', finishedKey.split(','))
      .then((c) => live && setCosts(c))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [finishedKey]);

  return (
    <Band
      title="Brains"
      aside={
        <button type="button" className="btn" onClick={manage}>
          Manage
        </button>
      }
    >
      <div className="home-cards">
        {brains.map((b) => {
          const c = counts[b.id];
          const facts = [
            c?.pages != null && plural(c.pages, 'page'),
            c?.sources != null && plural(c.sources, 'source'),
            b.lastRefreshAt
              ? `refreshed ${ago(b.lastRefreshAt)}`
              : 'never refreshed',
          ].filter(Boolean);
          const open = (focus: 'ask' | 'wiki' | 'drop') =>
            go({ kind: 'brain', brainId: b.id, focus });
          return (
            <div key={b.id} className="home-card project-brain">
              <span className="home-card-title">{b.name}</span>
              <span className="muted small">{facts.join(' · ')}</span>
              {b.wiki && (
                <span className="muted small">
                  {b.wiki.wikiName}
                  {b.wiki.rootPath !== '/' && b.wiki.rootPath}
                </span>
              )}
              <span className="project-links">
                <button
                  type="button"
                  className="link"
                  onClick={() => open('ask')}
                >
                  Ask
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() => open('wiki')}
                >
                  Browse
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() => open('drop')}
                >
                  Drop a file
                </button>
              </span>
            </div>
          );
        })}
        <button
          type="button"
          className="home-card project-new-brain"
          onClick={manage}
        >
          + New brain
        </button>
      </div>
      {finished.length > 0 && (
        <>
          <h3 className="project-subtitle">Recently finished</h3>
          <ul className="project-list">
            {finished.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="project-row project-row-button"
                  onClick={() => openTask(t.id)}
                >
                  <span className="project-row-title">
                    {t.workItem
                      ? `#${t.workItem.id} ${t.workItem.title}`
                      : t.name}
                  </span>
                  <span className="muted small">
                    {t.finishedAt && shortDate(t.finishedAt)}
                  </span>
                  <span className="small">{eur(costs[t.id] ?? 0)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Band>
  );
}
