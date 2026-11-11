import { useEffect, useState } from 'react';
import { openPiece } from '../../hooks/useReadingFeed';
import type { ReadingNudge } from '../../readingFeed';
import { useStore } from '../../store';

/** Long enough to read it, short enough to be gone when nobody looks. */
const LEAVES_AFTER_MS = 20_000;

const heading = (n: ReadingNudge) =>
  n.kind === 'work'
    ? 'A long read for your work'
    : n.piece === 'letter'
      ? 'Something you read no longer holds'
      : 'Something you read was brought up to date';

function detail(n: ReadingNudge): string {
  const parts = [n.title];
  if (n.piece === 'letter' && n.about) parts.push(`about ${n.about}`);
  if (n.work) parts.push(`for #${n.work.id} ${n.work.title}`);
  parts.push(`${n.minutes} min`);
  return parts.join(' · ');
}

/**
 * What a brain's build brought to read, in the notice corner: a change in something read, or a long read written for
 * the reader's work. Read opens it; it leaves by itself, and comes once per text.
 */
export function ReadingNotice() {
  const nudge = useStore((s) => s.readingNudge);
  const brain = useStore((s) =>
    nudge ? s.reading.find((b) => b.brainId === nudge.brainId) : undefined,
  );
  const close = useStore((s) => s.setReadingNudge);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!nudge || paused) return;
    const t = setTimeout(() => close(null), LEAVES_AFTER_MS);
    return () => clearTimeout(t);
  }, [nudge, paused, close]);

  if (!nudge) return null;
  return (
    <div
      className="notice notice-update"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close(null);
      }}
    >
      <div className="notice-update-body">
        <strong>{heading(nudge)}</strong>
        <span>{detail(nudge)}</span>
        <span className="muted small">
          {brain?.name}
          {nudge.more > 0 && `${brain ? ' · ' : ''}and ${nudge.more} more`}
        </span>
        <div className="notice-update-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              close(null);
              openPiece(
                nudge.brainId,
                nudge.path,
                'notice',
                nudge.kind,
                nudge.piece,
              );
            }}
          >
            Read
          </button>
        </div>
      </div>
      <button
        type="button"
        className="notice-close"
        aria-label="Dismiss"
        onClick={() => close(null)}
      >
        &times;
      </button>
    </div>
  );
}
