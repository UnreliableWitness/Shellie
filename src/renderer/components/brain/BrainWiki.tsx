import { useCallback, useEffect, useState } from 'react';
import type {
  BrainBook,
  BrainPageRow,
  BrainSourceRow,
} from '../../../shared/brain';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { isAfter, shortDay, type RecentEntry } from './recent';

/** The rows the Read view and the task tab share, refetched when the brain changes. */
export function useBrainPages(brainId: string): BrainPages {
  const [rows, setRows] = useState<BrainPageRow[]>([]);
  const [sources, setSources] = useState<BrainSourceRow[]>([]);
  const [log, setLog] = useState('');
  const [book, setBook] = useState<BrainBook | null>(null);
  /** Whether `brain:pages` and `brain:book` have answered once, so an empty list means an empty brain. */
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => {
    // Set together: pages known before the book would flash today's tree and landing for a brain that has a book.
    void Promise.all([
      api()
        .invoke('brain:pages', brainId)
        .catch(() => undefined),
      api()
        .invoke('brain:book', brainId)
        .catch(() => null),
    ]).then(([r, b]) => {
      if (r) setRows(r);
      setBook(b);
      setLoaded(true);
    });
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
  return { rows, sources, log, book, loaded };
}

/** A brain's pages, sources, log and book, as useBrainPages loads them. */
export type BrainPages = {
  rows: BrainPageRow[];
  sources: BrainSourceRow[];
  log: string;
  /** The brain's book (its chapters), or null without one or when it cannot be read. */
  book: BrainBook | null;
  /** Whether `brain:pages` and `brain:book` have answered once, so an empty list means an empty brain. */
  loaded: boolean;
};

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
