import type { BrainBook, BrainPageRow } from '../../../shared/brain';
import { BrainGraph } from './BrainGraph';
import { trackBrain } from './brainActions';
import { chapterOf } from './book';

/**
 * The front page of a brain with a book: its name and introduction (the summary of the first chapter's first page),
 * Continue reading when a page last read is still in the book, then the contents beside the graph of how the pages
 * link. A chapter row opens the chapter's first page; a chapter with no pages says so and is no button.
 */
export function BrainFront({
  brainName,
  book,
  rows,
  newPaths,
  continueAt,
  onOpen,
}: {
  brainName: string;
  book: BrainBook;
  rows: BrainPageRow[];
  /** Pages changed since the last visit: their chapter gets the dot. */
  newPaths: Set<string>;
  /** The page last read in this brain, if any. */
  continueAt: { path: string } | null;
  onOpen: (path: string) => void;
}) {
  const rowOf = (path: string) => rows.find((r) => r.path === path);
  const intro = rowOf(book.chapters[0]?.pages[0] ?? '')?.summary;
  const at = continueAt ? chapterOf(book, continueAt.path) : -1;
  return (
    <div className="brain-front">
      <h2>{brainName}</h2>
      {intro && <p className="brain-front-intro">{intro}</p>}
      {continueAt && at >= 0 && (
        <button
          type="button"
          className="brain-front-continue"
          onClick={() => {
            trackBrain('continue-reading');
            onOpen(continueAt.path);
          }}
        >
          <span>Continue reading</span>
          <b>
            {at + 1} · {book.chapters[at].title} ›{' '}
            {rowOf(continueAt.path)?.title ?? continueAt.path}
          </b>
        </button>
      )}
      <div className="brain-front-cols">
        <div>
          <h3 className="brain-front-heading">Contents</h3>
          <ul className="brain-front-chapters" aria-label="Contents">
            {book.chapters.map((c, n) => {
              const first = c.pages[0];
              const body = (
                <>
                  <span className="brain-front-num">{n + 1}</span>
                  <span className="brain-front-text">
                    <span className="brain-front-title">
                      {c.title}
                      {c.pages.some((p) => newPaths.has(p)) && (
                        <span
                          className="brain-dot"
                          role="img"
                          aria-label="new"
                        />
                      )}
                    </span>
                    <span className="brain-front-summary">
                      {first ? c.summary : 'Nothing captured on this yet'}
                    </span>
                  </span>
                  <span className="brain-front-count muted">
                    {first &&
                      `${c.pages.length} ${c.pages.length === 1 ? 'section' : 'sections'}`}
                  </span>
                </>
              );
              return (
                <li key={n}>
                  {first ? (
                    <button
                      type="button"
                      className="brain-front-chapter"
                      onClick={() => onOpen(first)}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="brain-front-chapter is-empty">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <BrainGraph rows={rows} newPaths={newPaths} onOpen={onOpen} />
      </div>
    </div>
  );
}
