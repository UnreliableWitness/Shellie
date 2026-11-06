import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BrainPageRow, BrainSourceRow } from '../../../shared/brain';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { BrainPage } from './BrainPage';
import { pinnedPages } from './brainTree';
import { BrainSearch } from './BrainSearch';
import { PageCard, PageSections } from './PageCards';
import { isAfter, recentEntries, shortDay, type RecentEntry } from './recent';
import { useBrainNav } from './useBrainNav';

const LAST_OPENED = (brainId: string) => `brain-last-opened:${brainId}`;

/** When the front page was last shown for this brain (a convenience in localStorage), and marks now. */
function useLastOpened(brainId: string): string | null {
  const [last] = useState<string | null>(() => {
    try {
      const prev = localStorage.getItem(LAST_OPENED(brainId));
      localStorage.setItem(LAST_OPENED(brainId), new Date().toISOString());
      return prev;
    } catch {
      return null;
    }
  });
  return last;
}

/** The rows the front page and the task tab share, refetched when the brain changes. */
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

function Recent({
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

/** The Brain screen's Wiki tab: pinned pages, what changed, search, every page as a card; a page opens in place. */
export function BrainWiki({ brainId }: { brainId: string }) {
  const { rows, sources, log } = useBrainPages(brainId);
  const nav = useBrainNav();
  const [searching, setSearching] = useState(false);
  const since = useLastOpened(brainId);
  const recent = useMemo(() => recentEntries(log, rows), [log, rows]);
  const newPaths = useMemo(() => {
    const out = new Set<string>();
    if (!since) return out;
    for (const e of recent)
      if (isAfter(e.at, since))
        for (const p of e.pages) if (p.path) out.add(p.path);
    return out;
  }, [recent, since]);
  const pinned = useMemo(() => pinnedPages(rows), [rows]);
  const open = useCallback(
    (path: string, anchor?: string) => nav.open(path, anchor),
    [nav],
  );

  return (
    <div className="brain-wiki">
      {nav.current && (
        <BrainPage
          brainId={brainId}
          path={nav.current.path}
          anchor={nav.current.anchor}
          rows={rows}
          sources={sources}
          canBack={nav.canBack}
          canForward={nav.canForward}
          onOpen={open}
          onBack={nav.back}
          onForward={nav.forward}
        />
      )}
      {/* The lists stay mounted under an open page, so a search and its results are there on Back. */}
      <div hidden={!!nav.current} className="brain-wiki-lists">
        {!nav.current && nav.canForward && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={nav.forward}
          >
            Forward ›
          </button>
        )}
        <BrainSearch brainId={brainId} onOpen={open} onActive={setSearching} />
        {!searching && (
          <>
            {pinned.length > 0 && (
              <section className="brain-section" aria-label="Pinned">
                <div className="brain-card-grid">
                  {pinned.map((r) => (
                    <PageCard
                      key={r.path}
                      row={r}
                      isNew={newPaths.has(r.path)}
                      onOpen={open}
                    />
                  ))}
                </div>
              </section>
            )}
            <Recent entries={recent} since={since} onOpen={open} />
            <PageSections rows={rows} newPaths={newPaths} onOpen={open} />
          </>
        )}
      </div>
    </div>
  );
}
