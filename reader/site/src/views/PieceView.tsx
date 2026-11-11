import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  isMarkedRead,
  type ReaderLetter,
  type ReaderMarkSet,
  type ReaderRead,
  type ReaderShelf,
} from '../../../../src/shared/reader';
import {
  bodyOf,
  splitLetter,
  splitRead,
} from '../../../../src/shared/readParts';
import { shortDay } from '../links';
import { Markdown } from '../Markdown';
import type { Reader } from '../sync';
import { usePiece } from '../usePiece';
import { usePlace } from '../usePlace';
import { ChevronLeft } from './icons';

/** Follows a link in a text: `target` is a path in the brain. */
type OpenLink = (target: string, anchor?: string) => void;

/** The one question of a long read: the answer stays closed until the reader asks for it. */
function Question({
  question,
  answer,
  render,
}: {
  question: string;
  answer: string;
  render: (text: string) => ReactNode;
}) {
  const [shown, setShown] = useState(false);
  // The button that had the focus is gone once the answer shows: the answer takes it, so a screen reader reads on.
  const answerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown) answerRef.current?.focus({ preventScroll: true });
  }, [shown]);
  return (
    <aside className="question" aria-label="Before you read on">
      <p className="label">Before you read on</p>
      <div className="question-text">{render(question)}</div>
      {shown ? (
        <div className="answer" ref={answerRef} tabIndex={-1}>
          <p className="label">Answer</p>
          {render(answer)}
        </div>
      ) : (
        <button
          type="button"
          className="button is-outline"
          onClick={() => setShown(true)}
        >
          Show the answer
        </button>
      )}
    </aside>
  );
}

/** The bar over a piece: back to the list, the minutes left and a thin line for the place in the text. */
function PieceBar({
  id,
  minutes,
  ready,
  resume,
  anchor,
  onBack,
}: {
  id: string;
  minutes: number;
  ready: boolean;
  resume: boolean;
  anchor?: string;
  onBack: () => void;
}) {
  const fraction = usePlace(id, ready, { resume, anchor });
  const left = Math.round(minutes * (1 - fraction));
  const pct = Math.round(fraction * 100);
  return (
    <header className="bar is-piece">
      <div className="bar-row">
        <button type="button" className="bar-button is-back" onClick={onBack}>
          <ChevronLeft />
          Reading list
        </button>
        {ready && (
          <span className="bar-note">
            {left < 1 ? 'Less than a minute left' : `about ${left} min left`}
          </span>
        )}
      </div>
      <div className="place" role="img" aria-label={`${pct}% read`}>
        <div style={{ width: `${pct}%` }} />
      </div>
    </header>
  );
}

function Missing({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="empty">
      <p>{children}</p>
      {onRetry && (
        <button type="button" className="button is-outline" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * A long read or a letter, set for reading: a serif column under its title; a long read's question with the answer
 * held back and the writer's gaps closed; a letter as its labelled sections, what was read struck through. Read is
 * a mark the reader sets at the end.
 */
export function PieceView({
  reader,
  shelf,
  marks,
  path,
  anchor,
  onOpenPiece,
  onOpenLink,
  onBack,
}: {
  reader: Reader;
  shelf: ReaderShelf;
  marks: ReaderMarkSet;
  path: string;
  anchor?: string;
  onOpenPiece: (path: string) => void;
  onOpenLink: OpenLink;
  onBack: () => void;
}) {
  const read: ReaderRead | undefined = shelf.reads.find((r) => r.path === path);
  const letter: ReaderLetter | undefined = read
    ? undefined
    : shelf.letters.find((l) => l.path === path);
  const row = read ?? letter;
  const { loaded, retry } = usePiece(reader, row?.id ?? null);
  const text = loaded.status === 'ready' ? loaded.piece.text : null;
  const body = useMemo(() => (text === null ? null : bodyOf(text)), [text]);
  const essay = useMemo(
    () => (body === null || !read ? null : splitRead(body)),
    [body, read],
  );
  const told = useMemo(
    () => (body === null || !letter ? null : splitLetter(body)),
    [body, letter],
  );
  // Whether the piece was read when it was opened: marking it at the end must not move the page.
  const [resume] = useState(() => !(row && isMarkedRead(marks, row)));

  if (!row)
    return (
      <div className="page">
        <header className="bar is-piece">
          <div className="bar-row">
            <button
              type="button"
              className="bar-button is-back"
              onClick={onBack}
            >
              <ChevronLeft />
              Reading list
            </button>
          </div>
        </header>
        <main className="piece">
          <Missing>This piece is no longer on your reading list.</Missing>
        </main>
      </div>
    );

  const md = (t: string) => (
    <Markdown text={t} path={path} onOpen={onOpenLink} />
  );
  const done = isMarkedRead(marks, row);
  const about = letter && shelf.reads.find((r) => r.path === letter.read);
  const newest = read
    ? shelf.letters
        .filter((l) => l.read === read.path)
        .sort((a, b) => (b.written ?? '').localeCompare(a.written ?? ''))[0]
    : undefined;
  const meta = [
    read ? 'Long read' : 'Letter',
    read?.chapter,
    row.written && `written ${shortDay(row.written)}`,
  ].filter(Boolean);

  return (
    <div className="page">
      <PieceBar
        id={row.id}
        minutes={row.minutes}
        ready={body !== null}
        resume={resume}
        anchor={anchor}
        onBack={onBack}
      />
      <main className="piece">
        <article aria-labelledby="piece-title">
          <header className="piece-head">
            <p className="piece-meta">
              {read?.work?.map((w) => (
                <span className="chip" key={w.id}>
                  #{w.id} {w.title}
                </span>
              ))}
              <span>{meta.join(' · ')}</span>
            </p>
            <h1 id="piece-title">{row.title}</h1>
            {about && (
              <p className="piece-link">
                About{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => onOpenPiece(about.path)}
                >
                  {about.title}
                </button>
              </p>
            )}
            {newest && (
              <p className="piece-link">
                Changed{newest.written && ` ${shortDay(newest.written)}`}:{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => onOpenPiece(newest.path)}
                >
                  {newest.title}
                </button>
              </p>
            )}
            {read?.stale && (
              <p className="quiet">
                Pages under it changed; Shellie can bring it up to date
              </p>
            )}
          </header>

          {loaded.status === 'loading' && <p className="quiet">Opening…</p>}
          {loaded.status === 'unreachable' && (
            <Missing onRetry={retry}>
              This piece is not kept on this phone yet. It loads when you are
              connected again.
            </Missing>
          )}
          {loaded.status === 'unreadable' && (
            <Missing onRetry={retry}>
              This piece could not be opened. Shellie sends it again at its next
              push.
            </Missing>
          )}

          {body !== null && (
            <div className="reading">
              {essay?.parts.map((p, i) =>
                p.kind === 'prose' ? (
                  <div key={i}>{md(p.text)}</div>
                ) : (
                  <Question
                    key={i}
                    question={p.question}
                    answer={p.answer}
                    render={md}
                  />
                ),
              )}
              {essay?.missing && (
                <details className="missing">
                  <summary>What the writer was missing</summary>
                  {md(essay.missing)}
                </details>
              )}
              {told?.opening && md(told.opening)}
              {told?.changes.map((c, i) => (
                <section key={i} className="change">
                  {c.title && <h2>{c.title}</h2>}
                  {c.intro && md(c.intro)}
                  {c.sections.map((s, j) => (
                    <div
                      key={j}
                      className={`told is-${s.kind}`}
                      role="group"
                      aria-label={s.label}
                    >
                      {c.title ? (
                        <h3 className="label">{s.label}</h3>
                      ) : (
                        <h2 className="label">{s.label}</h2>
                      )}
                      {md(s.text)}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
        </article>

        {body !== null && (
          <footer className="piece-foot">
            {done ? (
              <p className="was-read">
                <span>Read</span>
                <span aria-hidden="true"> · </span>
                <button
                  type="button"
                  className="link"
                  onClick={() => void reader.mark(shelf.brainId, row, false)}
                >
                  Mark unread
                </button>
              </p>
            ) : (
              <button
                type="button"
                className="button is-primary"
                onClick={() => void reader.mark(shelf.brainId, row, true)}
              >
                Mark as read
              </button>
            )}
          </footer>
        )}
      </main>
    </div>
  );
}
