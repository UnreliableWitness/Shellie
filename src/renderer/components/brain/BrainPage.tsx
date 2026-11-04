import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BrainPageRow, BrainSourceRow } from '../../../shared/brain';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { useStore } from '../../store';
import { MarkdownView } from '../docs/MarkdownView';
import { Lightbox } from './Lightbox';
import { PageTags } from './PageCards';
import { folderOf, shortDay, sourceLabel } from './recent';
import { VerifiedBar } from './VerifiedBar';

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

/**
 * One page or source of the brain, presented: a bar with back and forward, a header from its frontmatter (sources
 * and backlinks as chips), the body with working links, pictures in a lightbox.
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
}) {
  const notify = useStore((s) => s.notify);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picture, setPicture] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const body = useRef<HTMLDivElement>(null);
  const row = rows.find((r) => r.path === path) ?? null;
  const source = sources.find((s) => s.path === path) ?? null;

  // Only the answer for the path shown lands: a slow read of the previous page must not show under this header.
  const shown = useRef(path);
  shown.current = path;
  const load = useCallback(() => {
    const p = path;
    setError(null);
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

  const asset = useCallback(
    (p: string) => api().invoke('brain:asset', brainId, p),
    [brainId],
  );
  const openFile = (p: string) => {
    if (IMAGE.test(p)) {
      asset(p).then(
        (src) => setPicture({ src, alt: p.split('/').pop() ?? p }),
        (e: unknown) => notify('error', errorMessage(e)),
      );
    } else if (p.startsWith('sources/')) {
      api()
        .invoke('brain:openSource', brainId, p)
        .catch((e: unknown) => notify('error', errorMessage(e)));
    } else notify('error', `${p} is not a page, a picture or a source file`);
  };
  // A picture in the body opens at full size.
  const onBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    // A picture that is itself a link follows the link, not the lightbox.
    if (t.tagName === 'IMG' && !t.closest('a')) {
      const img = t as HTMLImageElement;
      if (img.src) setPicture({ src: img.src, alt: img.alt });
    }
  };
  const titleOf = (p: string) => rows.find((r) => r.path === p)?.title ?? p;

  const top = path.split('/')[0];
  const crumbs =
    top === 'wiki' || top === 'sources'
      ? [top, ...folderOf(path)]
      : folderOf(path);
  const title = row?.title ?? source?.path.split('/').pop() ?? path;

  return (
    <div className="brain-page">
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
          {row.sources.length > 0 && (
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
          {row.linkedFrom.length > 0 && (
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
          <VerifiedBar
            text={text}
            brainId={brainId}
            path={path}
            onChanged={load}
          />
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
          </span>
          {source.contents && (
            <p className="brain-page-lead">{source.contents}</p>
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
      {error && <p className="brain-error small">{error}</p>}
      {text === null && !error && <p className="muted small">Loading</p>}
      {text !== null && (
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
          />
        </div>
      )}
      {picture && (
        <Lightbox
          src={picture.src}
          alt={picture.alt}
          onClose={() => setPicture(null)}
        />
      )}
    </div>
  );
}
