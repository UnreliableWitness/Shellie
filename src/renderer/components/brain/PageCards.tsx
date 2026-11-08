import type { BrainPageRow, BrainPageType } from '../../../shared/brain';
import { shortDay } from './recent';

/** The section heading per type, in the front page's order. */
const TYPE_LABELS: Record<BrainPageType, string> = {
  subject: 'Subjects',
  account: 'Account',
  scope: 'Scope',
  component: 'Components',
  glossary: 'Glossary',
  decision: 'Decisions',
  meeting: 'Meetings',
  lesson: 'Lessons',
  digest: 'Digests',
  other: 'Other pages',
};

/** Confidence, verified and updated as the app's tags. */
export function PageTags({ row }: { row: BrainPageRow }) {
  const confidence =
    row.confidence === 'high'
      ? 'tag-green'
      : row.confidence === 'low'
        ? 'tag-warn'
        : row.confidence === 'medium'
          ? 'tag-muted'
          : null;
  return (
    <span className="brain-tags">
      {confidence && row.confidence && (
        <span className={`tag ${confidence}`}>{row.confidence}</span>
      )}
      {row.verified ? (
        row.changedSinceVerified ? (
          <span className="tag tag-warn">changed since verified</span>
        ) : (
          <span className="tag tag-muted">
            verified {shortDay(row.verified)}
          </span>
        )
      ) : (
        <span className="tag tag-muted">not verified</span>
      )}
      {row.lastUpdated && (
        <span className="muted small">updated {shortDay(row.lastUpdated)}</span>
      )}
    </span>
  );
}

/** One page as a card: title, summary, tags. */
export function PageCard({
  row,
  isNew,
  onOpen,
}: {
  row: BrainPageRow;
  isNew?: boolean;
  onOpen: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="brain-card"
      title={row.path}
      onClick={() => onOpen(row.path)}
    >
      <span className="brain-card-title">
        {row.title}
        {isNew && <span className="tag tag-green">new</span>}
      </span>
      <span
        className={
          row.summary ? 'brain-card-summary' : 'brain-card-summary muted'
        }
      >
        {row.summary || '(no summary)'}
      </span>
      <PageTags row={row} />
    </button>
  );
}

/** The pages grouped by type, as cards (the front page) or as one line each (the task tab). */
export function PageSections({
  rows,
  compact,
  newPaths,
  onOpen,
}: {
  rows: BrainPageRow[];
  compact?: boolean;
  newPaths?: Set<string>;
  onOpen: (path: string) => void;
}) {
  const types = (Object.keys(TYPE_LABELS) as BrainPageType[]).filter((t) =>
    rows.some((r) => r.type === t),
  );
  if (!types.length) return <p className="muted small">No pages yet.</p>;
  return (
    <>
      {types.map((t) => {
        const of = rows.filter((r) => r.type === t);
        return (
          <section
            key={t}
            className="brain-section"
            aria-label={TYPE_LABELS[t]}
          >
            <h3>
              {TYPE_LABELS[t]} <span className="muted">{of.length}</span>
            </h3>
            {compact ? (
              <ul className="list brain-page-lines">
                {of.map((r) => (
                  <li key={r.path}>
                    <button
                      type="button"
                      className="brain-page-line"
                      title={r.path}
                      onClick={() => onOpen(r.path)}
                    >
                      <span className="brain-card-title">{r.title}</span>
                      <span className="muted small brain-line-summary">
                        {r.summary}
                      </span>
                      <PageTags row={r} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="brain-card-grid">
                {of.map((r) => (
                  <PageCard
                    key={r.path}
                    row={r}
                    isNew={newPaths?.has(r.path)}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
