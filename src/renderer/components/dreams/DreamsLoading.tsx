import { PageHeader } from '../ui';

/** A Dreams page while its view loads, or when it could not be loaded. */
export function DreamsLoading(p: {
  title: string;
  /** What is said when the load failed. */
  message: string;
  failed: boolean;
  retry: () => void;
}) {
  return (
    <div className="page">
      <PageHeader title={p.title} />
      <div className="page-body">
        {p.failed ? (
          <>
            <p role="alert">{p.message}</p>
            <div className="actions">
              <button type="button" className="btn" onClick={p.retry}>
                Try again
              </button>
            </div>
          </>
        ) : (
          <p className="muted">Loading&hellip;</p>
        )}
      </div>
    </div>
  );
}
