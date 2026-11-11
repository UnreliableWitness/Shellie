/** The few drawings the site uses. All decorative: the text beside each says what it is. */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export const ChevronDown = () => (
  <svg
    aria-hidden="true"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    {...stroke}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const ChevronRight = () => (
  <svg
    aria-hidden="true"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    {...stroke}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const ChevronLeft = () => (
  <svg
    aria-hidden="true"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    {...stroke}
  >
    <path d="M15 6l-6 6 6 6" />
  </svg>
);

export const Dots = () => (
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
    <circle cx="5" cy="12" r="1.8" fill="currentColor" />
    <circle cx="12" cy="12" r="1.8" fill="currentColor" />
    <circle cx="19" cy="12" r="1.8" fill="currentColor" />
  </svg>
);

export const Cross = () => (
  <svg
    aria-hidden="true"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    {...stroke}
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const RING = 2 * Math.PI * 9;

/** A piece's state on the list: read (a tick), begun (how far), or not yet. */
export function StateMark({
  done,
  fraction,
}: {
  done: boolean;
  fraction: number;
}) {
  if (done)
    return (
      <svg className="mark is-done" aria-hidden="true" width="22" height="22">
        <circle cx="11" cy="11" r="10" />
        <path d="M6.5 11.5l3 3 6-6.5" />
      </svg>
    );
  if (fraction > 0)
    return (
      <svg className="mark is-begun" aria-hidden="true" width="22" height="22">
        <circle cx="11" cy="11" r="9" />
        <circle
          cx="11"
          cy="11"
          r="9"
          strokeDasharray={`${fraction * RING} ${RING}`}
          transform="rotate(-90 11 11)"
        />
      </svg>
    );
  return (
    <svg className="mark" aria-hidden="true" width="22" height="22">
      <circle cx="11" cy="11" r="9" />
    </svg>
  );
}
