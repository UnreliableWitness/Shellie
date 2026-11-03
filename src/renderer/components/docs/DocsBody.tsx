import type { DocView } from '../../docs/docsPrefs';
import { MarkdownView } from './MarkdownView';
import { SourceView } from './SourceView';

export type Doc = {
  path: string;
  text: string | null;
  error: 'too-large' | string | null;
  deleted: boolean;
};

/** The document area: empty, loading, error and too-large states, else the rendered or source view. */
export function DocsBody({
  asset,
  empty,
  doc,
  current,
  slow,
  view,
  highlight,
  onRetry,
  onOpenDoc,
  onOpenFile,
}: {
  asset: (path: string) => Promise<string>;
  /** The empty-state text, or null when there is something to show. */
  empty: string | null;
  doc: Doc | null;
  current: string | null;
  slow: boolean;
  view: DocView;
  highlight: number | null;
  onRetry(path: string): void;
  onOpenDoc(path: string, anchor?: string): void;
  onOpenFile(path: string): void;
}) {
  if (empty) return <div className="docs-state">{empty}</div>;
  if (!doc || doc.path !== current)
    return slow ? <div className="docs-state">Loading</div> : null;
  if (doc.error === 'too-large')
    return (
      <div className="docs-state">
        <p>This file is larger than 2 MB.</p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onOpenFile(doc.path)}
        >
          Open in VS Code
        </button>
      </div>
    );
  if (doc.error !== null)
    return (
      <div className="docs-state">
        <p>{doc.error}</p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onRetry(doc.path)}
        >
          Retry
        </button>
      </div>
    );
  if (doc.text === null) return null;
  return view === 'source' ? (
    <SourceView text={doc.text} highlightLine={highlight} />
  ) : (
    <MarkdownView
      asset={asset}
      path={doc.path}
      text={doc.text}
      onOpenDoc={onOpenDoc}
      onOpenFile={onOpenFile}
    />
  );
}
