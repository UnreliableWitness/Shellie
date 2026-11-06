import { useCallback, useMemo, useRef, useState } from 'react';
import { BrainLog } from './BrainLog';
import { BrainPage } from './BrainPage';
import { BrainSearch } from './BrainSearch';
import { BrainTree, type TreeSpecial } from './BrainTreeView';
import { pageGroups, pinnedPages, sourceGroup } from './brainTree';
import { RecentList, useBrainPages } from './BrainWiki';
import { PageCard } from './PageCards';
import { isAfter, recentEntries } from './recent';
import { useBrainNav } from './useBrainNav';

/**
 * The brain's Read view: a tree on the left (search on top), the open page in the middle with its rail, or Recent
 * changes, the log, or a landing of the pinned pages and what changed. Pages touched in the log after `since` get a dot.
 */
export function BrainRead({
  brainId,
  since,
}: {
  brainId: string;
  since: string | null;
}) {
  const { rows, sources, log } = useBrainPages(brainId);
  const nav = useBrainNav();
  const [special, setSpecial] = useState<TreeSpecial | null>(null);
  const [searching, setSearching] = useState(false);
  const searchPane = useRef<HTMLDivElement>(null);
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
  const start = useMemo(
    () => pinned.map((r) => ({ path: r.path, label: r.title })),
    [pinned],
  );
  const groups = useMemo(() => {
    const src = sourceGroup(sources);
    return src ? [...pageGroups(rows), src] : pageGroups(rows);
  }, [rows, sources]);

  const open = useCallback(
    (path: string, anchor?: string) => {
      setSpecial(null);
      nav.open(path, anchor);
    },
    [nav],
  );
  const openSpecial = useCallback(
    (which: TreeSpecial) => {
      nav.home();
      setSpecial(which);
    },
    [nav],
  );
  const current = nav.current?.path ?? special;

  return (
    <div
      className="brain-read"
      onKeyDown={(e) => {
        if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          searchPane.current?.querySelector('input')?.focus();
        }
      }}
    >
      <nav className="brain-read-tree" aria-label="Brain pages">
        <div ref={searchPane}>
          <BrainSearch
            brainId={brainId}
            onOpen={open}
            onActive={setSearching}
          />
        </div>
        {!searching && (
          <BrainTree
            groups={groups}
            start={start}
            current={current}
            newPaths={newPaths}
            onOpen={open}
            onOpenSpecial={openSpecial}
            collapsedKey={`shellie.brain.tree.${brainId}`}
          />
        )}
      </nav>
      <section className="brain-read-main" aria-label="Reading">
        {nav.current ? (
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
            layout="rail"
            onRemoved={nav.home}
          />
        ) : special === 'recent' ? (
          recent.length ? (
            <RecentList entries={recent} since={since} onOpen={open} />
          ) : (
            <p className="muted">Nothing has changed yet.</p>
          )
        ) : special === 'log' ? (
          <BrainLog brainId={brainId} />
        ) : (
          <div className="brain-read-landing">
            {nav.canForward && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={nav.forward}
              >
                Forward ›
              </button>
            )}
            {rows.length === 0 && (
              <p className="muted">No pages yet. Add a source in Add.</p>
            )}
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
            <RecentList entries={recent} since={since} onOpen={open} />
          </div>
        )}
      </section>
    </div>
  );
}
