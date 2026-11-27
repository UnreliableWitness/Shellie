import { useMemo } from 'react';
import {
  activityText,
  type BrainActivityEntry,
} from '../../../../shared/brainShare';
import { plural } from '../../../../shared/text';
import { clock } from '../../../format';
import { byDay, pageName, perPerson } from './history';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The History view: what each person added in the last seven days, then every entry under its day. `fresh`: the
 * entries colleagues made since this person last looked, marked as new.
 */
export function BrainHistory({
  entries,
  fresh,
  titles,
  shared,
  onOpenPage,
}: {
  entries: BrainActivityEntry[] | null;
  fresh: ReadonlySet<string>;
  /** Page titles by path, for the page links. */
  titles: ReadonlyMap<string, string>;
  shared: boolean;
  onOpenPage: (path: string) => void;
}) {
  const days = useMemo(() => byDay(entries ?? []), [entries]);
  const week = useMemo(
    () => perPerson(entries ?? [], Date.now() - WEEK_MS),
    [entries],
  );
  if (entries === null) return <p className="muted">Loading</p>;
  if (entries.length === 0)
    return <p className="muted">Nothing has been added to this brain yet.</p>;
  return (
    <div className="brain-history">
      {week.length > 0 && (
        <section className="brain-card" aria-label="The last 7 days">
          <h2>The last 7 days</h2>
          <ul className="brain-history-week">
            {week.map((p) => (
              <li key={p.who}>
                <span className="brain-history-who">{p.who}</span>
                <span className="muted">
                  {[
                    p.sources > 0 && plural(p.sources, 'source'),
                    p.pages > 0 &&
                      `${plural(p.pages, 'page')} added or changed`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {days.map((d) => (
        <section key={d.day} aria-label={d.day}>
          <h3 className="brain-history-day">{d.day}</h3>
          <ul className="brain-history-list">
            {d.entries.map((e) => (
              <li key={e.id} className={fresh.has(e.id) ? 'is-new' : undefined}>
                <span className="brain-history-time muted small">
                  {clock(e.at)}
                </span>
                <div className="brain-history-what">
                  <div>
                    <span className="brain-history-who">
                      {e.me ? 'You' : e.who}
                    </span>{' '}
                    {activityText(e)}
                    {fresh.has(e.id) && (
                      <span className="brain-history-new">New</span>
                    )}
                  </div>
                  {e.pages.length > 0 && (
                    <div className="brain-history-pages small">
                      {e.pages.map((p) => (
                        <button
                          key={p.path}
                          type="button"
                          className="link"
                          title={p.added ? 'New page' : 'Changed page'}
                          onClick={() => onOpenPage(p.path)}
                        >
                          {p.added && <span aria-hidden="true">+ </span>}
                          {titles.get(p.path) ?? pageName(p.path)}
                        </button>
                      ))}
                      {e.morePages > 0 && (
                        <span className="muted">and {e.morePages} more</span>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!shared && (
        <p className="small muted">
          Share this brain with colleagues to see what they add here too.
        </p>
      )}
    </div>
  );
}
