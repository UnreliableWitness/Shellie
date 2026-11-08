import type React from 'react';
import type { BrainPageRow } from '../../../shared/brain';
import { sourceLabel } from './recent';

/** A heading of the page body, as the outline lists it. */
export type RailHeading = { id: string; text: string; level: 2 | 3 };

/**
 * Beside a page in the Read view: its outline (h2/h3, a click scrolls there), the pages that link to it, the sources
 * it cites, then whether a person verified it. A section with nothing in it is left out.
 */
export function PageRail({
  headings,
  row,
  titleOf,
  onOpen,
  onJump,
  verified,
  outlineLabel = 'On this page',
  current,
}: {
  headings: RailHeading[];
  row: BrainPageRow;
  titleOf: (path: string) => string;
  onOpen: (path: string) => void;
  onJump: (id: string) => void;
  /** The `VerifiedBar` for the page. */
  verified: React.ReactNode;
  /** The outline's title: "In this chapter" when the outline lists a chapter's sections. */
  outlineLabel?: string;
  /** The outline id being read, highlighted. */
  current?: string;
}) {
  return (
    <aside className="brain-rail" aria-label="About this page">
      {headings.length > 0 && (
        <section className="brain-rail-section" aria-label={outlineLabel}>
          <h3 className="brain-rail-label">{outlineLabel}</h3>
          {headings.map((h) => (
            <a
              key={h.id}
              href={`#${h.id}`}
              className={`brain-rail-link brain-rail-outline${h.level === 3 ? ' is-sub' : ''}${h.id === current ? ' is-current' : ''}`}
              aria-current={h.id === current ? 'location' : undefined}
              onClick={(e) => {
                e.preventDefault();
                onJump(h.id);
              }}
            >
              {h.text}
            </a>
          ))}
        </section>
      )}
      {row.linkedFrom.length > 0 && (
        <section className="brain-rail-section" aria-label="Linked from">
          <h3 className="brain-rail-label">Linked from</h3>
          {row.linkedFrom.map((p) => (
            <button
              key={p}
              type="button"
              className="brain-rail-link"
              title={p}
              onClick={() => onOpen(p)}
            >
              {titleOf(p)}
            </button>
          ))}
        </section>
      )}
      {row.sources.length > 0 && (
        <section className="brain-rail-section" aria-label="Sources">
          <h3 className="brain-rail-label">Sources</h3>
          {row.sources.map((s) => (
            <button
              key={s}
              type="button"
              className="brain-rail-link"
              title={s}
              onClick={() => onOpen(s)}
            >
              {sourceLabel(s)}
            </button>
          ))}
        </section>
      )}
      {verified}
    </aside>
  );
}
