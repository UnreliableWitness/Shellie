import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrainSourceRow } from '../../../shared/brain';
import type { DocFile } from '../../../shared/types';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { useStore } from '../../store';
import { trackBrain } from './brainActions';
import { SourceBar } from './SourceBar';
import { VerifiedBar } from './VerifiedBar';
import { DocsBody, type Doc } from '../docs/DocsBody';

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
            {rows.get(f.path)?.note && (
              <span className="docs-file-contents brain-file-note small">
                {rows.get(f.path)?.note}
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
            brainId={brainId}
            path={current}
            onChanged={() => read(current)}
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
