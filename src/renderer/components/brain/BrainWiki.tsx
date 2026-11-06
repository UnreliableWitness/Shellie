import { useCallback, useEffect, useState } from 'react';
import type { BrainPageRow, BrainSourceRow } from '../../../shared/brain';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { isAfter, shortDay, type RecentEntry } from './recent';

/** The rows the Read view and the task tab share, refetched when the brain changes. */
export function useBrainPages(brainId: string) {
  const [rows, setRows] = useState<BrainPageRow[]>([]);
  const [sources, setSources] = useState<BrainSourceRow[]>([]);
  const [log, setLog] = useState('');
  const load = useCallback(() => {
    api()
      .invoke('brain:pages', brainId)
      .then(setRows, () => undefined);
    api()
      .invoke('brain:sources', brainId)
      .then(setSources, () => undefined);
    api()
      .invoke('brain:read', brainId, 'log.md')
      .then(
        (r) => setLog(r.text),
        () => setLog(''),
      );
  }, [brainId]);
  useEffect(load, [load]);
  useBrainChanged(brainId, load);
  return { rows, sources, log };
}

/** The last log entries that name pages, each page a link; entries since `since` are tagged new. */
export function RecentList({
  entries,
  since,
  onOpen,
}: {
  entries: RecentEntry[];
  since: string | null;
  onOpen: (path: string) => void;
}) {
  if (!entries.length) return null;
  return (
    <section className="brain-section" aria-label="Recent">
      <h3>Recent</h3>
      <ul className="list brain-recent">
        {entries.map((e, i) => (
          <li key={`${e.at}:${i}`} className="small">
            <span className="muted">{shortDay(e.at)}</span> {e.skill}{' '}
            {e.pages.map((p, j) => (
              <span key={j}>
                {j > 0 && ', '}
                {p.path ? (
                  <button
                    type="button"
                    className="link"
                    onClick={() => onOpen(p.path!)}
                  >
                    {p.label}
                  </button>
                ) : (
                  p.label
                )}
              </span>
            ))}
            {since && isAfter(e.at, since) && (
              <span className="tag tag-green">new</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
