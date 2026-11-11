import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BrainConflictRow,
  BrainJob,
  BrainPageRow,
} from '../../../shared/brain';
import { trackBrain, trackSettleOpen } from './brainActions';
import { chapterOf } from './book';
import { BrainChapter } from './BrainChapter';
import { BrainFront } from './BrainFront';
import { BrainGraph } from './BrainGraph';
import { BrainLog } from './BrainLog';
import { BrainLongRead } from './BrainLongRead';
import { BrainLongReads } from './BrainLongReads';
import { BrainPage } from './BrainPage';
import { BrainSearch } from './BrainSearch';
import { BrainTree, type TreeSpecial } from './BrainTreeView';
import {
  backOfBook,
  pageGroups,
  pinnedPages,
  sourceGroup,
  unplaced as unplacedPages,
} from './brainTree';
import { local } from '../../localStorage';
import { loadMarks, saveMarks, unreadCount, type ReadMarks } from './longReads';
import { RecentList, type BrainPages } from './BrainWiki';
import { PageCard } from './PageCards';
import { isAfter, recentEntries } from './recent';
import { useBrainNav } from './useBrainNav';

const CONTINUE = (brainId: string) => `shellie.brain.continue.${brainId}`;

/** The page last read in the brain (a convenience in localStorage), or null. */
function readContinue(brainId: string): { path: string } | null {
  try {
    const path = local()?.getItem(CONTINUE(brainId));
    return path ? { path } : null;
  } catch {
    return null;
  }
}

/** One line above a page that an open conflict involves: what it disagrees with, and Settle. */
function ConflictLine({
  path,
  conflicts,
  rows,
  onSettle,
}: {
  path: string;
  conflicts: BrainConflictRow[];
  rows: BrainPageRow[];
  onSettle: (conflictId: string) => void;
}) {
  const hit = conflicts.find((c) =>
    c.conflict
      ? c.conflict.claims.a.page === path || c.conflict.claims.b.page === path
      : c.page === path,
  );
  if (!hit) return null;
  const claims = hit.conflict?.claims;
  const other = claims
    ? claims.a.page === path
      ? claims.b.page
      : claims.a.page
    : null;
  const title = (p: string) => rows.find((r) => r.path === p)?.title ?? p;
  return (
    <div
      className="brain-conflict-line small"
      role="status"
      aria-label="Conflict on this page"
    >
      <span className="grow">
        {other
          ? `This page disagrees with ${title(other)}`
          : `Lint found a conflict here: ${hit.detail}`}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          trackSettleOpen('read');
          onSettle(hit.id);
        }}
      >
        Settle
      </button>
    </div>
  );
}

/**
 * The brain's Read view: a tree on the left (search on top), the open page in the middle with its rail, or Recent
 * changes, the log, or a landing of how the pages link, the pinned pages and what changed. Pages touched in the log after `since` get a dot.
 * A new `openRequest` (another `n`) opens its page, as a link from the Add view does. Long reads has its own entry:
 * the list, and a reader for a long read or a letter; what is read is the reader's own mark, kept per brain.
 */
export function BrainRead({
  brainId,
  brainName = '',
  pages,
  since,
  openRequest,
  active,
  jobs,
  skillsReady,
  canWrite = false,
  conflicts = [],
  onSettle,
}: {
  brainId: string;
  /** The brain's name, the front page's title. */
  brainName?: string;
  /** The brain's pages, sources, log and book, loaded once by the screen. */
  pages: BrainPages;
  since: string | null;
  openRequest?: { path: string; n: number } | null;
  /** Whether the view is shown: only then does ⌘K/Ctrl+K anywhere on the page go to its search. */
  active: boolean;
  /** The brain's jobs, for a source's Re-evaluate. */
  jobs?: BrainJob[];
  /** False when the brain's skills cannot re-evaluate pictures (`picturesReady`). */
  skillsReady?: boolean;
  /** Whether the brain's skills can write long reads (`writeReady`). */
  canWrite?: boolean;
  /** Open conflicts: a page in one says so above it, with Settle. */
  conflicts?: BrainConflictRow[];
  onSettle?: (conflictId: string) => void;
}) {
  const { rows, sources, log, book, reads, loaded } = pages;
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
    if (book) return backOfBook(rows, sources);
    const src = sourceGroup(sources);
    return src ? [...pageGroups(rows), src] : pageGroups(rows);
  }, [rows, sources, book]);
  const unplaced = useMemo(
    () => (book ? unplacedPages(rows, book) : []),
    [rows, book],
  );
  // The section being read in the open chapter, for the tree to highlight.
  const [reading, setReading] = useState<string | null>(null);
  const onReading = useCallback(
    (path: string) => {
      setReading(path);
      try {
        local()?.setItem(CONTINUE(brainId), path);
      } catch {
        /* no storage: Continue reading is not offered */
      }
    },
    [brainId],
  );

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
  const [marks, setMarks] = useState<ReadMarks>(() => loadMarks(brainId));
  useEffect(() => setMarks(loadMarks(brainId)), [brainId]);
  const onMark = useCallback(
    (row: { path: string; hash: string }, read: boolean) => {
      const next = { ...loadMarks(brainId) };
      if (read)
        next[row.path] = { hash: row.hash, at: new Date().toISOString() };
      else delete next[row.path];
      saveMarks(brainId, next);
      setMarks(next);
    },
    [brainId],
  );
  const unreadReads = useMemo(() => unreadCount(reads, marks), [reads, marks]);
  const openReads = useCallback(() => {
    trackBrain('reads-open');
    openSpecial('reads');
  }, [openSpecial]);
  const shown = nav.current?.path;
  const longRead = shown?.startsWith('reads/') ?? false;
  const openChapter = book && shown ? chapterOf(book, shown) : -1;
  // The highlighted page follows the section being read, while the chapter shown is the one it belongs to.
  const highlight =
    book &&
    reading &&
    openChapter >= 0 &&
    chapterOf(book, reading) === openChapter
      ? reading
      : shown;
  const current = longRead ? 'reads' : (highlight ?? special);
  const treeBook = book && {
    chapters: book.chapters,
    openChapter,
    titleOf: (p: string) => rows.find((r) => r.path === p)?.title ?? p,
    onOpenChapter: (n: number) => {
      const first = book.chapters[n]?.pages[0];
      if (first) open(first);
    },
  };

  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (openRequest) openRef.current(openRequest.path);
  }, [openRequest]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return;
      const search = searchPane.current?.querySelector('input');
      if (!search || typedElsewhere(e.target, search)) return;
      e.preventDefault();
      search.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);

  return (
    <div className="brain-read">
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
            onOpenSpecial={(which) =>
              which === 'reads' ? openReads() : openSpecial(which)
            }
            unreadReads={unreadReads}
            collapsedKey={`shellie.brain.tree.${brainId}`}
            book={treeBook ?? undefined}
            unplaced={unplaced}
          />
        )}
      </nav>
      <section className="brain-read-main" aria-label="Reading">
        {nav.current && onSettle && (
          <ConflictLine
            path={nav.current.path}
            conflicts={conflicts}
            rows={rows}
            onSettle={onSettle}
          />
        )}
        {nav.current && longRead ? (
          <BrainLongRead
            brainId={brainId}
            path={nav.current.path}
            anchor={nav.current.anchor}
            reads={reads}
            rows={rows}
            marks={marks}
            onMark={onMark}
            jobs={jobs ?? []}
            canWrite={canWrite}
            canBack={nav.canBack}
            canForward={nav.canForward}
            onOpen={open}
            onBack={nav.back}
            onForward={nav.forward}
            onList={openReads}
          />
        ) : nav.current && book && openChapter >= 0 ? (
          <BrainChapter
            brainId={brainId}
            book={book}
            index={openChapter}
            path={nav.current.path}
            anchor={nav.current.anchor}
            opened={nav.opened}
            rows={rows}
            canBack={nav.canBack}
            canForward={nav.canForward}
            onOpen={open}
            onBack={nav.back}
            onForward={nav.forward}
            onReading={onReading}
          />
        ) : nav.current ? (
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
            jobs={jobs}
            skillsReady={skillsReady}
          />
        ) : special === 'recent' ? (
          recent.length ? (
            <RecentList entries={recent} since={since} onOpen={open} />
          ) : (
            <p className="muted">Nothing has changed yet.</p>
          )
        ) : special === 'log' ? (
          <BrainLog brainId={brainId} />
        ) : special === 'reads' ? (
          <BrainLongReads
            brainId={brainId}
            reads={reads}
            book={book}
            jobs={jobs ?? []}
            canWrite={canWrite}
            marks={marks}
            onOpen={open}
          />
        ) : book ? (
          <div className="brain-read-landing is-front">
            {nav.canForward && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={nav.forward}
              >
                Forward ›
              </button>
            )}
            <BrainFront
              brainName={brainName}
              book={book}
              rows={rows}
              newPaths={newPaths}
              continueAt={readContinue(brainId)}
              onOpen={open}
              longReads={
                canWrite || reads.reads.length > 0
                  ? {
                      written: book.chapters.filter(
                        (c) =>
                          c.pages.length &&
                          reads.reads.some((r) => r.chapter === c.title),
                      ).length,
                      chapters: book.chapters.filter((c) => c.pages.length)
                        .length,
                      unread: unreadReads,
                      onOpen: openReads,
                    }
                  : undefined
              }
            />
          </div>
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
            {loaded && rows.length === 0 && (
              <p className="muted">No pages yet. Add a source in Add.</p>
            )}
            <BrainGraph rows={rows} newPaths={newPaths} onOpen={open} />
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

/** Whether a key went to the terminal, a field other than the search box, or editable text: there ⌘K is not ours. */
function typedElsewhere(target: EventTarget | null, search: HTMLInputElement) {
  if (!(target instanceof HTMLElement) || target === search) return false;
  return (
    !!target.closest('.brain-terminal') ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}
