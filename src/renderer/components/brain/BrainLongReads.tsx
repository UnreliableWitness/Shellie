import { useMemo, useState, type FormEvent } from 'react';
import {
  MAX_TOPIC,
  writeTarget,
  type BrainBook,
  type BrainJob,
  type BrainLetterRow,
  type BrainReadRow,
  type BrainReads,
} from '../../../shared/brain';
import { entryPath } from '../../../shared/reader';
import {
  brainReadingList,
  progressLine,
  type ReadingEntry,
  type ReadingRead,
  type WorkRef,
} from '../../../shared/reading';
import { api, tryInvoke } from '../../api';
import { trackPieceOpen, type OpenWhy } from '../../hooks/useReadingFeed';
import { useStore } from '../../store';
import { trackReadWrite } from './brainActions';
import {
  isRead,
  openTopics,
  writeJob,
  writeStatus,
  type ReadMarks,
} from './longReads';
import { shortDay } from './recent';

/** One long read or letter in a list: its title (a dot while unread), what it says, and how long it takes. */
function ReadRow({
  row,
  summary,
  work,
  read,
  changed,
  stale,
  onOpen,
}: {
  row: BrainReadRow | BrainLetterRow;
  summary?: string;
  /** The work it bears on, named under "For your work this sprint". */
  work?: WorkRef[];
  read: boolean;
  /** Read once, and written again since: it counts as read, and says so. */
  changed?: boolean;
  stale?: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="brain-reads-row" onClick={onOpen}>
      <span className="brain-reads-title">
        {row.title}
        {!read && <span className="brain-dot" role="img" aria-label="unread" />}
        {stale && <span className="tag tag-warn">out of date</span>}
      </span>
      {work?.map((w) => (
        <span key={w.id} className="brain-reads-work small">
          #{w.id} {w.title}
        </span>
      ))}
      {summary && <span className="brain-reads-summary">{summary}</span>}
      <span className="brain-reads-meta muted small">
        {row.minutes} min
        {row.written && ` · written ${shortDay(row.written)}`}
        {read && ' · read'}
        {changed && ' · read, changed since'}
      </span>
    </button>
  );
}

/**
 * The brain's long reads as a reading list, in the order the phone shows them: how far the reader is, the long reads
 * for the work in front of them, what changed in the ones they read, the book's chapters in order (each with its
 * long read or Write), then the long reads on a topic with a field to ask for one, and the letters not listed above.
 */
export function BrainLongReads({
  brainId,
  reads,
  book,
  jobs,
  canWrite,
  marks,
  onOpen,
}: {
  brainId: string;
  reads: BrainReads;
  book: BrainBook | null;
  jobs: BrainJob[];
  /** False when the brain's skills cannot write long reads (`writeReady`). */
  canWrite: boolean;
  marks: ReadMarks;
  onOpen: (path: string) => void;
}) {
  const notify = useStore((s) => s.notify);
  // Which long read bears on which work is main's to say; the long reads and marks here are the view's own, fresher.
  const feed = useStore((s) => s.reading.find((b) => b.brainId === brainId));
  const [topic, setTopic] = useState('');
  const chapters = useMemo(
    () => (book?.chapters ?? []).filter((c) => c.pages.length),
    [book],
  );
  const list = useMemo(() => {
    const work = new Map(feed?.reads.map((r) => [r.path, r.work]));
    return brainReadingList(
      {
        chapters: chapters.map((c) => c.title),
        reads: reads.reads.map((r): ReadingRead =>
          work.get(r.path)?.length ? { ...r, work: work.get(r.path) } : r,
        ),
        letters: reads.letters,
      },
      marks,
    );
  }, [feed, chapters, reads, marks]);
  const topics = openTopics(jobs);
  const titleOf = (path: string) =>
    reads.reads.find((r) => r.path === path)?.title;
  const listed = new Set(list.changed.map(entryPath));
  const letters = reads.letters.filter((l) => !listed.has(l.path));

  const write = (target: string, kind: 'chapter' | 'topic') => {
    trackReadWrite(kind);
    return tryInvoke(
      () => api().invoke('brain:write', brainId, target),
      notify,
    );
  };
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const text = topic.trim();
    if (!text) return;
    if (await write(writeTarget({ topic: text }), 'topic')) setTopic('');
  };
  const open = (
    path: string,
    why: OpenWhy,
    kind: 'read' | 'letter' = 'read',
  ) => {
    trackPieceOpen('list', why, kind);
    onOpen(path);
  };
  const row = (r: ReadingRead, why: OpenWhy) => (
    <ReadRow
      row={r}
      summary={r.summary}
      work={why === 'work' ? r.work : undefined}
      read={isRead(marks, r)}
      changed={
        why !== 'changed' && marks[r.path]?.read === true && !isRead(marks, r)
      }
      stale={r.stale.length > 0}
      onOpen={() => open(r.path, why)}
    />
  );
  const letterRow = (l: BrainLetterRow, why: OpenWhy) => (
    <ReadRow
      row={l}
      summary={titleOf(l.read) ? `About ${titleOf(l.read)}` : undefined}
      read={isRead(marks, l)}
      onOpen={() => open(l.path, why, 'letter')}
    />
  );
  const entry = (e: ReadingEntry, why: OpenWhy) => (
    <li key={entryPath(e)}>
      {e.kind === 'letter' ? letterRow(e.letter, why) : row(e.read, why)}
    </li>
  );
  const inBook = list.foundations.length;
  const inBookRead = list.foundations.filter((e) => e.done).length;

  return (
    <div className="brain-reads">
      <h2>Long reads</h2>
      <p className="brain-reads-intro muted">
        Essays the brain writes from its pages and their sources, one subject
        each, to read from start to end. When the pages under one change, a
        letter says what no longer holds.
      </p>
      {list.total > 0 && (
        <div className="brain-reads-progress">
          <div
            className="brain-reads-bar"
            role="progressbar"
            aria-label="Long reads read"
            aria-valuemin={0}
            aria-valuemax={list.total}
            aria-valuenow={list.done}
          >
            <span style={{ width: `${(list.done / list.total) * 100}%` }} />
          </div>
          <span className="muted small">{progressLine(list)}</span>
        </div>
      )}
      {!canWrite && (
        <p className="small" role="status">
          Update skills to write long reads: Settings › Project › Brains.
        </p>
      )}
      {list.work.length > 0 && (
        <section aria-label="For your work this sprint">
          <h3 className="brain-front-heading">For your work this sprint</h3>
          <ul className="brain-reads-list">
            {list.work.map((e) => entry(e, 'work'))}
          </ul>
        </section>
      )}
      {list.changed.length > 0 && (
        <section aria-label="Changed since you read it">
          <h3 className="brain-front-heading">Changed since you read it</h3>
          <ul className="brain-reads-list">
            {list.changed.map((e) => entry(e, 'changed'))}
          </ul>
        </section>
      )}
      {chapters.length > 0 && (
        <section aria-label="Foundations">
          <h3 className="brain-front-heading">
            Foundations
            {inBook > 0 && (
              <span className="brain-reads-count muted">
                {inBookRead} of {inBook} read
              </span>
            )}
          </h3>
          <ul className="brain-reads-list">
            {chapters.map((c) => {
              const r = list.foundations.find(
                (e) => e.kind === 'read' && e.read.chapter === c.title,
              );
              const target = writeTarget({ chapter: c.title });
              const w = writeJob(jobs, target);
              return (
                <li key={c.title}>
                  {r?.kind === 'read' ? (
                    <>
                      <span className="brain-reads-chapter muted small">
                        {c.title}
                      </span>
                      {row(r.read, 'foundations')}
                    </>
                  ) : (
                    <div className="brain-reads-row is-empty">
                      <span className="brain-reads-title">{c.title}</span>
                      <span className="brain-reads-meta muted small">
                        {w?.pending
                          ? writeStatus(w.job)
                          : w?.job.status === 'failed'
                            ? 'The last try failed, see Activity in Add'
                            : 'No long read yet'}
                      </span>
                      {canWrite && !w?.pending && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          aria-label={`Write a long read on ${c.title}`}
                          onClick={() => void write(target, 'chapter')}
                        >
                          Write
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section aria-label="Later">
        <h3 className="brain-front-heading">Later</h3>
        <ul className="brain-reads-list">
          {topics.map((j) => (
            <li key={j.id}>
              <div className="brain-reads-row is-empty">
                <span className="brain-reads-title">
                  {j.target?.slice('topic:'.length)}
                </span>
                <span className="brain-reads-meta muted small">
                  {j.status === 'failed'
                    ? 'The last try failed, see Activity in Add'
                    : writeStatus(j)}
                </span>
                {canWrite && j.status === 'failed' && j.target && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-label={`Write a long read on ${j.target.slice('topic:'.length)}`}
                    onClick={() => void write(j.target ?? '', 'topic')}
                  >
                    Write
                  </button>
                )}
              </div>
            </li>
          ))}
          {list.later.map((e) => entry(e, 'later'))}
        </ul>
        {canWrite && (
          <form className="brain-reads-ask" onSubmit={(e) => void ask(e)}>
            <input
              className="field grow"
              aria-label="Topic for a long read"
              placeholder="A subject you want to understand, in one line"
              maxLength={MAX_TOPIC}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-sm"
              disabled={!topic.trim()}
            >
              Write
            </button>
          </form>
        )}
      </section>
      {letters.length > 0 && (
        <section aria-label="Letters">
          <h3 className="brain-front-heading">Letters</h3>
          <ul className="brain-reads-list">
            {letters.map((l) => (
              <li key={l.path}>{letterRow(l, 'later')}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
