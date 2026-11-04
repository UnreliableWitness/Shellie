import { useCallback, useEffect, useRef, useState } from 'react';
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

  const load = useCallback(() => {
    setError(null);
    api()
      .invoke('brain:read', brainId, path)
      .then(
        (r) => setText(r.text),
        (e: unknown) => {
          setText(null);
          setError(errorMessage(e));
        },
      );
  }, [brainId, path]);
  useEffect(load, [load]);
  useBrainChanged(brainId, load);

  // After the text renders, the anchor's element (a heading id) scrolls into view.
  useEffect(() => {
    if (text === null || !anchor) return;
    const el = body.current?.querySelector(`[id="${CSS.escape(anchor)}"]`);
    el?.scrollIntoView?.({ block: 'start' });
  }, [text, anchor]);

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
    }
  };
  const titleOf = (p: string) => rows.find((r) => r.path === p)?.title ?? p;

  const crumbs = [path.split('/')[0], ...folderOf(path)];
  const title = row?.title ?? source?.path.split('/').pop() ?? path;

  return (
    <div className="brain-page">
      <div className="brain-page-bar">
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
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && ' › '}
              {c}
            </span>
          ))}
          {' › '}
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
        <div className="brain-doc brain-page-body" ref={body}>
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
