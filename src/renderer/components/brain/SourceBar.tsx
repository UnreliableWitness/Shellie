import { useState } from 'react';
import { SHARED_WARNING } from './sharing';

/** Remove a source (two clicks): the file, its original and pictures go; a /retract job takes its claims out. */
export function SourceBar({
  path,
  shared = false,
  onRemove,
}: {
  path: string;
  /** The brain is shared: the server's history keeps the file. */
  shared?: boolean;
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
            {shared && ` ${SHARED_WARNING}`}
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
