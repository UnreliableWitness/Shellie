import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BrainBook, BrainPageRow } from '../../../shared/brain';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { MarkdownView } from '../docs/MarkdownView';
import { sectionBeingRead, sectionId, shownBefore, stripTitle } from './book';
import { PageTags } from './PageCards';
import { PageRail, type RailHeading } from './PageRail';
import { usePageMedia } from './usePageMedia';
import { VerifiedBar } from './VerifiedBar';

/** One page of the chapter as read: its raw text, or why it could not be. */
type Read =
  | { text: string; error?: undefined }
  | { text?: undefined; error: string };

/**
 * A chapter of the book: its title and introduction, then its pages one after another as one continuous read, with
 * the rail beside it (the sections, and the sources, backlinks and Mark verified of the section being read) and the
 * previous and next chapter at the end.
 */
export function BrainChapter({
  brainId,
  book,
  index,
  path,
  anchor,
  rows,
  canBack,
  canForward,
  onOpen,
  onBack,
  onForward,
  onReading,
}: {
  brainId: string;
  book: BrainBook;
  /** The chapter shown, in `book.chapters`. */
  index: number;
  /** The page to scroll to: the chapter's first page opens at the chapter's top. */
  path: string;
  anchor?: string;
  rows: BrainPageRow[];
  canBack: boolean;
  canForward: boolean;
  onOpen: (path: string, anchor?: string) => void;
  onBack: () => void;
  onForward: () => void;
  /** The page being read changed (scrolling), for the tree to highlight. */
  onReading?: (path: string) => void;
}) {
  const chapter = book.chapters[index];
  const pages = chapter?.pages ?? [];
  const { asset, openFile, onBodyClick, lightbox } = usePageMedia(brainId);
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [reads, setReads] = useState<Read[] | null>(null);
  const target = Math.max(0, pages.indexOf(path));
  const [reading, setReading] = useState(target);

  // Only the answer for the chapter shown lands: a slow read of the previous one must not show under this title.
  const key = `${brainId}\n${pages.join('\n')}`;
  const shown = useRef(key);
  shown.current = key;
  const load = useCallback(() => {
    const k = key;
    void Promise.all(
      pages.map((p): Promise<Read> =>
        api()
          .invoke('brain:read', brainId, p)
          .then(
            (r) => ({ text: r.text }),
            (e: unknown) => ({ error: errorMessage(e) }),
          ),
      ),
    ).then((r) => {
      if (shown.current === k) setReads(r);
    });
    // `pages` is in `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brainId, key]);
  useEffect(() => {
    setReads(null);
    load();
  }, [load]);
  useBrainChanged(brainId, load);

  // Once per navigation (path and anchor), not on every refetch: a reader halfway down stays there.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (reads === null) return;
    const at = `${index}:${path}#${anchor ?? ''}`;
    if (scrolledFor.current === at) return;
    scrolledFor.current = at;
    setReading(target);
    const n = pages.indexOf(path);
    if (n <= 0 && !anchor) {
      // The first page, or none: the chapter's title and introduction come into view with it.
      bar.current?.scrollIntoView?.({ block: 'start' });
      return;
    }
    const prefix = `${sectionId(n)}-`;
    const el = root.current?.querySelector(
      `[id="${CSS.escape(anchor && n >= 0 ? prefix + anchor : sectionId(n))}"]`,
    );
    (
      el ?? root.current?.querySelector(`[id="${sectionId(n)}"]`)
    )?.scrollIntoView?.({
      block: 'start',
    });
  }, [reads, index, path, anchor, pages, target]);

  // The section being read follows the scroll of the reading column.
  const latest = useRef({ onReading, target });
  latest.current = { onReading, target };
  const loaded = reads !== null;
  useEffect(() => {
    const scroller = root.current?.closest('.brain-read-main');
    if (!scroller || !loaded) return;
    const onScroll = () => {
      const sections = Array.from(
        root.current?.querySelectorAll('section[data-path]') ?? [],
      );
      setReading(sectionBeingRead(sections, scroller, latest.current.target));
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [loaded, key]);
  const readingPath = pages[reading];
  useEffect(() => {
    if (readingPath) latest.current.onReading?.(readingPath);
  }, [readingPath]);

  if (!chapter) return null;
  const rowOf = (p: string) => rows.find((r) => r.path === p);
  const titleOf = (p: string) => rowOf(p)?.title ?? p;
  const jump = (id: string) =>
    root.current
      ?.querySelector(`[id="${CSS.escape(id)}"]`)
      ?.scrollIntoView?.({ block: 'start' });
  const outline: RailHeading[] = pages.map((p, n) => ({
    id: sectionId(n),
    text: titleOf(p),
    level: 2,
  }));
  const readingRow = readingPath ? rowOf(readingPath) : undefined;
  const readingRead = reads?.[reading];

  // The nearest chapter with pages on either side; one without pages has nothing to open.
  const neighbour = (step: 1 | -1) => {
    for (let i = index + step; i >= 0 && i < book.chapters.length; i += step)
      if (book.chapters[i].pages.length > 0) return book.chapters[i];
    return null;
  };
  const prev = neighbour(-1);
  const next = neighbour(1);

  return (
    <div className="brain-page with-rail brain-chapter" ref={root}>
      <div className="brain-page-bar" ref={bar}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label="Back"
          disabled={!canBack}
          onClick={onBack}
        >
          ‹ Back
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label="Forward"
          disabled={!canForward}
          onClick={onForward}
        >
          Forward ›
        </button>
        <span className="brain-crumbs muted small" aria-label="Location">
          Chapter {index + 1}
        </span>
      </div>
      <header className="brain-page-head">
        <h2>{chapter.title}</h2>
        {chapter.intro && (
          <div className="brain-doc brain-page-body">
            <MarkdownView
              asset={asset}
              path={pages[0] ?? 'wiki/index.md'}
              text={chapter.intro}
              onOpenDoc={onOpen}
              onOpenFile={openFile}
              idPrefix="intro-"
            />
          </div>
        )}
      </header>
      <div className="brain-page-main">
        {reads === null && <p className="muted small">Loading</p>}
        {reads !== null &&
          pages.map((p, n) => {
            const row = rowOf(p);
            const read = reads[n];
            return (
              <section
                key={p}
                id={sectionId(n)}
                data-path={p}
                className="brain-chapter-section"
              >
                <header className="brain-section-head">
                  <h2>{titleOf(p)}</h2>
                  {row && <PageTags row={row} />}
                </header>
                {read.error !== undefined ? (
                  <p className="brain-error small">{read.error}</p>
                ) : (
                  <div
                    className="brain-doc brain-page-body"
                    onClick={onBodyClick}
                  >
                    <MarkdownView
                      asset={asset}
                      path={p}
                      text={stripTitle(read.text)}
                      onOpenDoc={onOpen}
                      onOpenFile={openFile}
                      idPrefix={`${sectionId(n)}-`}
                      figures={{ shown: shownBefore(rows, pages, n) }}
                    />
                  </div>
                )}
              </section>
            );
          })}
        {reads !== null && (prev || next) && (
          <nav className="brain-chapter-nav" aria-label="Chapters">
            {prev ? (
              <button
                type="button"
                className="btn btn-ghost"
                aria-label="Previous chapter"
                onClick={() => onOpen(prev.pages[0])}
              >
                ‹ {prev.title}
              </button>
            ) : (
              <span />
            )}
            {next && (
              <button
                type="button"
                className="btn btn-ghost"
                aria-label="Next chapter"
                onClick={() => onOpen(next.pages[0])}
              >
                {next.title} ›
              </button>
            )}
          </nav>
        )}
      </div>
      {reads !== null && readingRow && (
        <PageRail
          headings={outline}
          outlineLabel="In this chapter"
          current={sectionId(reading)}
          row={readingRow}
          titleOf={titleOf}
          onOpen={onOpen}
          onJump={jump}
          verified={
            readingRead?.text !== undefined && (
              <VerifiedBar
                text={readingRead.text}
                brainId={brainId}
                path={readingPath}
                onChanged={load}
              />
            )
          }
        />
      )}
      {lightbox}
    </div>
  );
}
