import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  readingList,
  type ListEntry,
  type ReaderMarkSet,
  type ReaderShelf,
} from '../../../../src/shared/reader';
import { duration, shortDay } from '../links';
import { loadPlaces, type Places } from '../local';
import { ChevronDown, ChevronRight, StateMark } from './icons';

const STALE = 'Pages under it changed; Shellie can bring it up to date';

const percent = (fraction: number) => Math.round(fraction * 100);

/** One piece on the list. A read one is a single quiet line; an unread one says what it is and how long. */
function Entry({
  entry,
  places,
  onOpen,
}: {
  entry: ListEntry;
  places: Places;
  onOpen: (path: string) => void;
}) {
  const piece = entry.kind === 'read' ? entry.read : entry.letter;
  if (entry.done)
    return (
      <li>
        <button
          type="button"
          className="entry is-done"
          onClick={() => onOpen(piece.path)}
        >
          <StateMark done fraction={0} />
          <span className="entry-title">
            {piece.title}
            <span className="sr-only">, read</span>
          </span>
        </button>
      </li>
    );
  const pct = percent(places[piece.id] ?? 0);
  const meta = [
    entry.kind === 'read' ? 'Long read' : 'Letter',
    `${piece.minutes} min`,
    shortDay(piece.written),
    pct > 0 ? `${pct}% read` : '',
  ].filter(Boolean);
  return (
    <li>
      <button
        type="button"
        className="entry"
        onClick={() => onOpen(piece.path)}
      >
        <StateMark done={false} fraction={pct / 100} />
        <span className="entry-text">
          <span className="entry-title">{piece.title}</span>
          {entry.kind === 'read'
            ? entry.read.summary && (
                <span className="entry-summary">{entry.read.summary}</span>
              )
            : entry.about && (
                <span className="entry-summary">
                  A letter about {entry.about}
                </span>
              )}
          <span className="entry-meta">
            {entry.kind === 'read' && entry.changed && (
              <span className="chip is-changed">Changed</span>
            )}
            {entry.kind === 'read' &&
              entry.read.work?.map((w) => (
                <span className="chip" key={w.id}>
                  #{w.id} {w.title}
                </span>
              ))}
            <span>{meta.join(' · ')}</span>
          </span>
          {entry.kind === 'read' && entry.read.stale && (
            <span className="entry-stale">{STALE}</span>
          )}
        </span>
      </button>
    </li>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h2 id={id}>{title}</h2>
        <span>{count}</span>
      </div>
      <ul>{children}</ul>
    </section>
  );
}

/** The home screen: what to read next in one brain, in the order `readingList` gives. */
export function ReadingList({
  shelf,
  marks,
  onOpen,
}: {
  shelf: ReaderShelf;
  marks: ReaderMarkSet;
  onOpen: (path: string) => void;
}) {
  const list = useMemo(() => readingList(shelf, marks), [shelf, marks]);
  // Read once per visit to the list: the places change only while a piece is open.
  const places = useMemo(loadPlaces, []);
  const [laterOpen, setLaterOpen] = useState(false);
  const later = useId();
  const entries = (items: ListEntry[]) =>
    items.map((e) => (
      <Entry
        key={e.kind === 'read' ? e.read.path : e.letter.path}
        entry={e}
        places={places}
        onOpen={onOpen}
      />
    ));
  const readCount = `${list.done} of ${list.total} read`;
  const foundationsDone = list.foundations.filter((e) => e.done).length;

  return (
    <main className="list">
      <div className="list-head">
        <h1>{shelf.name}</h1>
        {shelf.reads.length > 0 && (
          <>
            <div className="progress" role="img" aria-label={readCount}>
              <div
                style={{
                  width: `${list.total ? (100 * list.done) / list.total : 0}%`,
                }}
              />
            </div>
            <p className="quiet">
              {readCount}
              {list.minutesLeft > 0 &&
                ` · about ${duration(list.minutesLeft)} left`}
            </p>
          </>
        )}
      </div>

      {shelf.reads.length === 0 && (
        <p className="empty">
          Nothing to read yet. Long reads are written in Shellie: Brain › Read ›
          Long reads.
        </p>
      )}

      {list.work.length > 0 && (
        <Section
          title="For your work this sprint"
          count={String(list.work.length)}
        >
          {entries(list.work)}
        </Section>
      )}
      {list.changed.length > 0 && (
        <Section
          title="Changed since you read it"
          count={String(list.changed.length)}
        >
          {entries(list.changed)}
        </Section>
      )}
      {list.foundations.length > 0 && (
        <Section
          title="Foundations, in order"
          count={`${foundationsDone} of ${list.foundations.length}`}
        >
          {entries(list.foundations)}
        </Section>
      )}
      {list.later.length > 0 && (
        <section className="section is-later">
          <h2>
            <button
              type="button"
              className="later-toggle"
              aria-expanded={laterOpen}
              aria-controls={laterOpen ? later : undefined}
              onClick={() => setLaterOpen((o) => !o)}
            >
              <span>Later</span>
              <span className="later-count">
                {list.later.length === 1
                  ? '1 piece'
                  : `${list.later.length} pieces`}
                {laterOpen ? <ChevronDown /> : <ChevronRight />}
              </span>
            </button>
          </h2>
          {laterOpen && <ul id={later}>{entries(list.later)}</ul>}
        </section>
      )}
    </main>
  );
}
