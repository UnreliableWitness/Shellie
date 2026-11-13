import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BrainJob,
  BrainPageRow,
  BrainSourceRow,
} from '../../../shared/brain';
import { errorMessage } from '../../../shared/errors';
import { plural } from '../../../shared/text';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { useStore } from '../../store';
import { MarkdownView } from '../docs/MarkdownView';
import { trackBrain } from './brainActions';
import { PageTags } from './PageCards';
import { PageRail, type RailHeading } from './PageRail';
import { folderOf, shortDay, sourceLabel } from './recent';
import { SourceBar } from './SourceBar';
import {
  MIRROR_PICTURES,
  pictureGaps,
  SourcePictures,
  useSourcePictures,
} from './SourcePictures';
import { usePageMedia } from './usePageMedia';
import { VerifiedBar } from './VerifiedBar';

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const NOTHING_SHOWN: ReadonlySet<string> = new Set();

/**
 * One page or source of the brain, presented: a bar with back and forward, a header from its frontmatter (sources
 * and backlinks as chips), the body with working links, pictures in a lightbox. With `layout="rail"` (the Read view)
 * the sources, backlinks and Mark verified move to a rail beside the body, with the page's outline, and a source
 * can be removed. A source shows its Pictures panel above its text; `sources/wiki` is the wiki mirror's pictures alone.
 */
export function BrainPage({
  brainId,
  path,
  anchor,
  rows,
  sources,
  canBack,
  canForward,
  onOpen,
  onBack,
  onForward,
  layout = 'chips',
  onRemoved,
  jobs = [],
  skillsReady = true,
  shared = false,
}: {
  brainId: string;
  path: string;
  anchor?: string;
  rows: BrainPageRow[];
  sources: BrainSourceRow[];
  canBack: boolean;
  canForward: boolean;
  onOpen: (path: string, anchor?: string) => void;
  onBack: () => void;
  onForward: () => void;
  /** Where the sources, backlinks and Mark verified go: chips in the header, or a rail beside the body. */
  layout?: 'chips' | 'rail';
  /** After the source shown was removed (rail layout only). */
  onRemoved?: () => void;
  /** The brain's jobs, for the Pictures panel's Re-evaluate. */
  jobs?: BrainJob[];
  /** False when the brain's skills cannot re-evaluate pictures (`picturesReady`). */
  skillsReady?: boolean;
  /** The brain is shared (Remove warns that the server keeps the file). */
  shared?: boolean;
}) {
  const notify = useStore((s) => s.notify);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { asset, openFile, view, onBodyClick, lightbox } =
    usePageMedia(brainId);
  const body = useRef<HTMLDivElement>(null);
  const rail = layout === 'rail';
  const [headings, setHeadings] = useState<RailHeading[]>([]);
  const row = rows.find((r) => r.path === path) ?? null;
  const source = sources.find((s) => s.path === path) ?? null;
  // The mirror's pages share one set of pictures, shown on `sources/wiki` (no file to read), not on each page.
  const mirror = path === MIRROR_PICTURES;
  const pictures = useSourcePictures(
    brainId,
    mirror || (source && !path.startsWith(`${MIRROR_PICTURES}/`)) ? path : null,
  );
  const gaps = pictures ? pictureGaps(pictures.counts) : 0;
  const gapTag = gaps > 0 && (
    <span className="tag tag-warn">
      {plural(gaps, 'picture')} not interpreted
    </span>
  );

  // Only the answer for the path shown lands: a slow read of the previous page must not show under this header.
  const shown = useRef(path);
  shown.current = path;
  const load = useCallback(() => {
    const p = path;
    setError(null);
    if (p === MIRROR_PICTURES) {
      setText('');
      return;
    }
    api()
      .invoke('brain:read', brainId, p)
      .then(
        (r) => {
          if (shown.current === p) setText(r.text);
        },
        (e: unknown) => {
          if (shown.current !== p) return;
          setText(null);
          setError(errorMessage(e));
        },
      );
  }, [brainId, path]);
  useEffect(() => {
    setText(null);
    load();
  }, [load]);
  useBrainChanged(brainId, load);
  const bar = useRef<HTMLDivElement>(null);

  // After the text renders, the anchor's element (a heading id) scrolls into view.
  // Once per navigation (path and anchor), not on every refetch: a reader halfway down stays there.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (text === null) return;
    const key = `${path}#${anchor ?? ''}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    if (!anchor) {
      // A new page starts at its top, whatever the scroll position the last one left.
      bar.current?.scrollIntoView?.({ block: 'start' });
      return;
    }
    const el = body.current?.querySelector(`[id="${CSS.escape(anchor)}"]`);
    el?.scrollIntoView?.({ block: 'start' });
  }, [text, anchor, path]);

  // The outline is read from the rendered body: the heading ids are the ones MarkdownView gave them.
  useEffect(() => {
    if (!rail || text === null) {
      setHeadings([]);
      return;
    }
    const found = body.current?.querySelectorAll('h2[id], h3[id]') ?? [];
    setHeadings(
      Array.from(found, (h) => ({
        id: h.id,
        text: h.textContent ?? '',
        level: h.tagName === 'H3' ? 3 : 2,
      })),
    );
  }, [rail, text]);
  const jump = (id: string) =>
    body.current
      ?.querySelector(`[id="${CSS.escape(id)}"]`)
      ?.scrollIntoView?.({ block: 'start' });

  const titleOf = (p: string) => rows.find((r) => r.path === p)?.title ?? p;

  const top = path.split('/')[0];
  const crumbs =
    top === 'wiki' || top === 'sources'
      ? [top, ...folderOf(path)]
      : folderOf(path);
  const title = mirror
    ? 'Wiki mirror'
    : (row?.title ?? source?.path.split('/').pop() ?? path);
  const verifiedBar = text !== null && (
    <VerifiedBar text={text} brainId={brainId} path={path} onChanged={load} />
  );
  const removeSource = () =>
    api()
      .invoke('brain:removeSource', brainId, path)
      .then(
        () => {
          trackBrain('remove-source');
          onRemoved?.();
        },
        (e: unknown) => notify('error', errorMessage(e)),
      );
  // Above the source text (and above the Remove bar in the Read view).
  const picturesPanel = (
    <>
      {pictures && (pictures.rows.length > 0 || pictures.counts.tiny > 0) && (
        <SourcePictures
          key={pictures.source}
          brainId={brainId}
          pictures={pictures}
          jobs={jobs}
          skillsReady={skillsReady}
          onOpen={onOpen}
          onView={view}
          titleOf={(p) =>
            rows.find((r) => r.path === p)?.title ?? sourceLabel(p)
          }
        />
      )}
      {mirror && pictures?.rows.length === 0 && (
        <p className="muted small">The wiki mirror has no pictures.</p>
      )}
    </>
  );
  const main = (
    <>
      {error && <p className="brain-error small">{error}</p>}
      {text === null && !error && <p className="muted small">Loading</p>}
      {text !== null && !mirror && (
        <div
          className="brain-doc brain-page-body"
          ref={body}
          onClick={onBodyClick}
        >
          <MarkdownView
            asset={asset}
            path={path}
            text={text.replace(FRONTMATTER, '')}
            onOpenDoc={onOpen}
            onOpenFile={openFile}
            // The Read view of a wiki page shows the pictures its text cites; sources and the chips layout do not.
            figures={rail && row ? { shown: NOTHING_SHOWN } : undefined}
          />
        </div>
      )}
    </>
  );

  return (
    <div
      className={`brain-page${rail ? ' with-rail' : ''}${rail && !row ? ' no-rail' : ''}`}
    >
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
          {crumbs.map((c) => (
            <span key={c}>{c} › </span>
          ))}
          <span>{title}</span>
        </span>
      </div>
      {text !== null && row && (
        <header className="brain-page-head">
          <h2>{row.title}</h2>
          {row.summary && <p className="brain-page-lead">{row.summary}</p>}
          <PageTags row={row} />
          {!rail && row.sources.length > 0 && (
            <div className="brain-chips">
              <span className="muted small">Sources</span>
              {row.sources.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="tag tag-muted brain-chip"
                  title={s}
                  onClick={() => onOpen(s)}
                >
                  {sourceLabel(s)}
                </button>
              ))}
            </div>
          )}
          {!rail && row.linkedFrom.length > 0 && (
            <div className="brain-chips">
              <span className="muted small">Linked from</span>
              {row.linkedFrom.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="tag tag-muted brain-chip"
                  title={p}
                  onClick={() => onOpen(p)}
                >
                  {titleOf(p)}
                </button>
              ))}
            </div>
          )}
          {!rail && verifiedBar}
        </header>
      )}
      {text !== null && !row && source && (
        <header className="brain-page-head">
          <h2>{title}</h2>
          <span className="brain-tags">
            <span className="tag tag-muted">{source.type}</span>
            <span className="muted small">
              ingested {shortDay(source.ingestedAt.slice(0, 10))}
            </span>
            {source.captured ? (
              <span className="tag tag-green">captured</span>
            ) : (
              <span className="tag tag-warn">not captured</span>
            )}
            {gapTag}
          </span>
          {source.contents && (
            <p className="brain-page-lead">{source.contents}</p>
          )}
          {source.note && (
            <blockquote className="brain-source-note" aria-label="Note">
              <span className="muted small">Note</span> {source.note}
            </blockquote>
          )}
          {source.original && (
            <div className="brain-chips">
              <span className="muted small">Original</span>
              <button
                type="button"
                className="tag tag-muted brain-chip"
                onClick={() => openFile(source.original!)}
              >
                {source.original.split('/').pop()}
              </button>
            </div>
          )}
        </header>
      )}
      {mirror && (
        <header className="brain-page-head">
          <h2>{title}</h2>
          <span className="brain-tags">{gapTag}</span>
          <p className="brain-page-lead">
            The pictures of the DevOps wiki's pages
          </p>
        </header>
      )}
      {rail ? (
        <div className="brain-page-main">
          {picturesPanel}
          {text !== null &&
            !row &&
            source &&
            !path.startsWith('sources/wiki/') && (
              <SourceBar
                path={path}
                shared={shared}
                onRemove={() => void removeSource()}
              />
            )}
          {main}
        </div>
      ) : (
        <>
          {picturesPanel}
          {main}
        </>
      )}
      {rail && text !== null && row && (
        <PageRail
          headings={headings}
          row={row}
          titleOf={titleOf}
          onOpen={onOpen}
          onJump={jump}
          verified={verifiedBar}
        />
      )}
      {lightbox}
    </div>
  );
}
