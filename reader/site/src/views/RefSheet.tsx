import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReaderShelf } from '../../../../src/shared/reader';
import { bodyOf } from '../../../../src/shared/readParts';
import { Markdown, scrollToAnchor } from '../Markdown';
import type { Reader } from '../sync';
import { usePiece } from '../usePiece';
import { Cross } from './icons';

/** The ids in the sheet's text, apart from those of the piece under it. */
const IDS = 'ref-';

/**
 * A cited page or source, over the piece that cites it: its title, a close button and its text, at the heading the
 * link named. A page that was not sent to the phone says so.
 */
export function RefSheet({
  reader,
  shelf,
  path,
  anchor,
  onOpenLink,
  onClose,
}: {
  reader: Reader;
  shelf: ReaderShelf;
  path: string;
  anchor?: string;
  onOpenLink: (target: string, anchor?: string) => void;
  onClose: () => void;
}) {
  const ref = Object.hasOwn(shelf.refs, path) ? shelf.refs[path] : null;
  const { loaded, retry } = usePiece(reader, ref?.id ?? null);
  const text = loaded.status === 'ready' ? loaded.piece.text : null;
  const body = useMemo(() => (text === null ? null : bodyOf(text)), [text]);
  const sheet = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // The piece under the sheet keeps its place: it does not scroll while the sheet is open.
  useEffect(() => {
    document.documentElement.classList.add('has-sheet');
    return () => document.documentElement.classList.remove('has-sheet');
  }, []);
  useEffect(() => {
    sheet.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Each page starts at its top, or at the heading the link named.
  useLayoutEffect(() => {
    scroller.current?.scrollTo?.(0, 0);
    if (body !== null && anchor) scrollToAnchor(IDS, anchor);
  }, [path, anchor, body]);

  const title = ref?.title ?? 'Not on your phone';
  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      ref={sheet}
    >
      <header className="sheet-bar">
        <h2>{title}</h2>
        <button
          type="button"
          className="bar-button"
          aria-label="Close"
          onClick={onClose}
        >
          <Cross />
        </button>
      </header>
      <div className="sheet-body" ref={scroller}>
        <div className="sheet-column">
          {!ref && (
            <p className="empty">
              This page was not sent to your phone. Open it in Shellie.
            </p>
          )}
          {ref && loaded.status === 'loading' && (
            <p className="quiet">Opening…</p>
          )}
          {ref && loaded.status === 'unreachable' && (
            <div className="empty">
              <p>
                This page is not kept on this phone yet. It loads when you are
                connected again.
              </p>
              <button
                type="button"
                className="button is-outline"
                onClick={retry}
              >
                Try again
              </button>
            </div>
          )}
          {ref && loaded.status === 'unreadable' && (
            <p className="empty">
              This page could not be opened. Open it in Shellie.
            </p>
          )}
          {body !== null && (
            <div className="reading is-ref">
              <Markdown
                text={body}
                path={path}
                idPrefix={IDS}
                onOpen={onOpenLink}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
