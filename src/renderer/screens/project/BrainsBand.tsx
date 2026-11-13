import { useEffect, useMemo, useState } from 'react';
import type { BrainCounts, BrainView } from '../../../shared/brain';
import { tasksOfProject } from '../../../shared/projectGraph';
import type { Connection } from '../../../shared/types';
import { api } from '../../api';
import { JoinCard } from '../../components/brain/JoinCard';
import { Band } from '../../components/home/Band';
import { ago, eur, plural, taskLabel } from '../../format';
import { useBrains } from '../../hooks/useBrains';
import { useTaskCosts } from '../../hooks/useTaskCosts';
import { useStore } from '../../store';
import { NEW_BRAIN_SECTION } from '../settings/BrainsSection';

const RECENT = 3;

/** Page and source counts per brain (`brain:list` has none), one light call each. */
function useCounts(brains: BrainView[]): Record<string, BrainCounts> {
  const [counts, setCounts] = useState<Record<string, BrainCounts>>({});
  const key = brains.map((b) => b.id).join(',');
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(',') : []) {
      api()
        .invoke('brain:counts', id)
        .then((c) => {
          if (live) setCounts((all) => ({ ...all, [id]: c }));
        })
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
  const manage = (section: 'project-brains' | typeof NEW_BRAIN_SECTION) =>
    go({ kind: 'settings', scope: 'project', connectionId: id, section });

  const finished = useMemo(
    () =>
      tasksOfProject(tasks, repos, id)
        .filter((t) => t.status === 'done' && t.finishedAt !== null)
        .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
        .slice(0, RECENT),
    [tasks, repos, id],
  );
  const costs = useTaskCosts(finished.map((t) => t.id));

  return (
    <Band
      title="Brains"
      aside={
        <button
          type="button"
          className="btn"
          onClick={() => manage('project-brains')}
        >
          Manage
        </button>
      }
    >
      <div className="home-cards">
        <JoinCard connectionId={id} project={connection.project} />
        {brains.map((b) => {
          const c = counts[b.id];
          const facts = [
            c && plural(c.pages, 'page'),
            c && plural(c.sources, 'source'),
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
          onClick={() => manage(NEW_BRAIN_SECTION)}
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
                  <span className="project-row-title">{taskLabel(t)}</span>
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
