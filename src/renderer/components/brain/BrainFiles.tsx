import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrainSourceRow } from '../../../shared/brain';
import type { DocFile } from '../../../shared/types';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { useStore } from '../../store';
import { trackBrain } from './brainActions';
import { DocsBody, type Doc } from '../docs/DocsBody';

/** A frontmatter field of a page's text, as written. */
const field = (text: string, name: string): string | null => {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const m =
    fm && new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'm').exec(fm[1]);
  if (!m) return null;
  // Quotes and a trailing comment off; a date keeps its day only.
  const v = m[1]
    .replace(/\s+#.*$/, '')
    .replace(/^["']|["']$/g, '')
    .trim();
  return v ? (/^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v) : null;
};

/** When a person last checked the page, and the button to say they just did. Only a person writes `verified`. */
function VerifiedBar({
  text,
  onVerify,
}: {
  text: string;
  onVerify: () => void;
}) {
  const verified = field(text, 'verified');
  const updated = field(text, 'last_updated');
  const confidence = field(text, 'confidence');
  const changedSince = !!verified && !!updated && updated > verified;
  return (
    <div className="brain-verified small" role="status">
      <span className="muted">
        {verified
          ? changedSince
            ? `Verified ${verified}, changed since (${updated})`
            : `Verified ${verified}`
          : 'Not verified by anyone yet'}
        {confidence ? ` · confidence ${confidence}` : ''}
      </span>
      <button type="button" className="btn btn-sm" onClick={onVerify}>
        {verified ? 'Verify again' : 'Mark verified'}
      </button>
    </div>
  );
}

/** Remove a source (two clicks): the file, its original and pictures go; a /retract job takes its claims out. */
function SourceBar({ path, onRemove }: { path: string; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="brain-verified small" role="status">
      {confirming ? (
        <>
          <span>
            Remove {path}? Its claims are taken out of the pages; the file stays
            in the brain&apos;s git history.
          </span>
          <span className="brain-bar-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setConfirming(false);
                onRemove();
              }}
            >
              Remove source
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirming(false)}
            >
              Keep
            </button>
          </span>
        </>
      ) : (
        <>
          <span className="muted">Source</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setConfirming(true)}
          >
            Remove…
          </button>
        </>
      )}
    </div>
  );
}

/** A brain's Markdown files: a list on the left, the chosen file rendered on the right. */
export function BrainFiles({
  brainId,
  dir,
  filter = '',
}: {
  brainId: string;
  dir: 'wiki' | 'sources' | 'root';
  /** Only files whose path contains this (any case). */
  filter?: string;
}) {
  const notify = useStore((s) => s.notify);
  const [files, setFiles] = useState<DocFile[] | null>(null);
  /** For the sources list: what each file holds, by path. */
  const [rows, setRows] = useState<Map<string, BrainSourceRow>>(new Map());
  const [current, setCurrent] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const open = useRef<string | null>(null);

  const read = useCallback(
    (path: string) => {
      api()
        .invoke('brain:read', brainId, path)
        .then(
          (r) => ({ path, text: r.text, error: null, deleted: false }),
          (e) => ({ path, text: null, error: errorMessage(e), deleted: false }),
        )
        .then((d) => {
          if (open.current === path) setDoc(d);
        });
    },
    [brainId],
  );
  const choose = useCallback(
    (path: string) => {
      open.current = path;
      setCurrent(path);
      read(path);
    },
    [read],
  );
  const loadList = useCallback(() => {
    if (dir === 'sources') {
      api()
        .invoke('brain:sources', brainId)
        .then(
          (list) => setRows(new Map(list.map((r) => [r.path, r]))),
          () => undefined,
        );
    }
    api()
      .invoke('brain:files', brainId, dir)
      .then(setFiles, () => setFiles([]));
  }, [brainId, dir]);

  useEffect(loadList, [loadList]);
  useBrainChanged(brainId, () => {
    loadList();
    if (open.current) read(open.current);
  });
  const asset = useCallback(
    (path: string) => api().invoke('brain:asset', brainId, path),
    [brainId],
  );

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? files?.filter((f) => f.path.toLowerCase().includes(needle))
    : files;

  return (
    <div className="brain-files">
      <aside className="docs-list" aria-label="Files">
        {files?.length === 0 && (
          <p className="docs-list-empty muted small">No files yet.</p>
        )}
        {!!files?.length && shown?.length === 0 && (
          <p className="docs-list-empty muted small">No file matches.</p>
        )}
        {shown?.map((f) => (
          <button
            key={f.path}
            type="button"
            className={`docs-file${f.path === current ? ' is-current' : ''}`}
            title={f.path}
            onClick={() => choose(f.path)}
          >
            <span className="docs-file-name">{f.path}</span>
            {rows.get(f.path)?.contents && (
              <span className="docs-file-contents muted small">
                {rows.get(f.path)?.contents}
              </span>
            )}
          </button>
        ))}
      </aside>
      <div className="brain-doc">
        {dir === 'sources' &&
          current &&
          doc?.text != null &&
          !current.startsWith('sources/wiki/') && (
            <SourceBar
              path={current}
              onRemove={() =>
                api()
                  .invoke('brain:removeSource', brainId, current)
                  .then(
                    () => {
                      trackBrain('remove-source');
                      open.current = null;
                      setCurrent(null);
                      setDoc(null);
                      loadList();
                    },
                    (e: unknown) => notify('error', errorMessage(e)),
                  )
              }
            />
          )}
        {dir === 'wiki' && current && doc?.text != null && (
          <VerifiedBar
            text={doc.text}
            onVerify={() =>
              api()
                .invoke('brain:verify', brainId, current)
                .then(
                  () => {
                    trackBrain('verify');
                    read(current);
                  },
                  (e: unknown) => notify('error', errorMessage(e)),
                )
            }
          />
        )}
        <DocsBody
          asset={asset}
          empty={current === null ? 'Pick a file' : null}
          doc={doc}
          current={current}
          slow
          view="rendered"
          highlight={null}
          onRetry={read}
          onOpenDoc={choose}
          onOpenFile={() => undefined}
        />
      </div>
    </div>
  );
}
