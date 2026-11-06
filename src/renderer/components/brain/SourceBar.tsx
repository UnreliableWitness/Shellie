import { useState } from 'react';

/** Remove a source (two clicks): the file, its original and pictures go; a /retract job takes its claims out. */
export function SourceBar({
  path,
  onRemove,
}: {
  path: string;
  onRemove: () => void;
}) {
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
