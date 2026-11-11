import { useState, type FormEvent } from 'react';
import {
  MAX_TOPIC,
  writeTarget,
  type BrainBook,
  type BrainJob,
  type BrainLetterRow,
  type BrainReadRow,
  type BrainReads,
} from '../../../shared/brain';
import { api, tryInvoke } from '../../api';
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
  read,
  stale,
  onOpen,
}: {
  row: BrainReadRow | BrainLetterRow;
  summary?: string;
  read: boolean;
  stale?: boolean;
  onOpen: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="brain-reads-row"
      onClick={() => onOpen(row.path)}
    >
      <span className="brain-reads-title">
        {row.title}
        {!read && <span className="brain-dot" role="img" aria-label="unread" />}
        {stale && <span className="tag tag-warn">out of date</span>}
      </span>
      {summary && <span className="brain-reads-summary">{summary}</span>}
      <span className="brain-reads-meta muted small">
        {row.minutes} min
        {row.written && ` · written ${shortDay(row.written)}`}
        {read && ' · read'}
      </span>
    </button>
  );
}

/**
 * The brain's long reads: the letters (what changed in a long read), then one line per chapter of the book with its
 * long read or Write, then the long reads on a topic and a field to ask for one. A long read being written says so.
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
  const [topic, setTopic] = useState('');
  const chapters = (book?.chapters ?? []).filter((c) => c.pages.length);
  const others = reads.reads.filter((r) => r.chapter === null);
  const topics = openTopics(jobs);
  const titleOf = (path: string) =>
    reads.reads.find((r) => r.path === path)?.title;

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
  const row = (r: BrainReadRow) => (
    <ReadRow
      row={r}
      summary={r.summary}
      read={isRead(marks, r)}
      stale={r.stale.length > 0}
      onOpen={onOpen}
    />
  );

  return (
    <div className="brain-reads">
      <h2>Long reads</h2>
      <p className="brain-reads-intro muted">
        Essays the brain writes from its pages and their sources, one subject
        each, to read from start to end. When the pages under one change, a
        letter says what no longer holds.
      </p>
      {!canWrite && (
        <p className="small" role="status">
          Update skills to write long reads: Settings › Project › Brains.
        </p>
      )}
      {reads.letters.length > 0 && (
        <section aria-label="Letters">
          <h3 className="brain-front-heading">Letters</h3>
          <ul className="brain-reads-list">
            {reads.letters.map((l) => (
              <li key={l.path}>
                <ReadRow
                  row={l}
                  summary={
                    titleOf(l.read) ? `About ${titleOf(l.read)}` : undefined
                  }
                  read={isRead(marks, l)}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {chapters.length > 0 && (
        <section aria-label="By chapter">
          <h3 className="brain-front-heading">By chapter</h3>
          <ul className="brain-reads-list">
            {chapters.map((c) => {
              const r = reads.reads.find((x) => x.chapter === c.title);
              const target = writeTarget({ chapter: c.title });
              const w = writeJob(jobs, target);
              return (
                <li key={c.title}>
                  {r ? (
                    <>
                      <span className="brain-reads-chapter muted small">
                        {c.title}
                      </span>
                      {row(r)}
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
      <section aria-label="On a topic">
        <h3 className="brain-front-heading">On a topic</h3>
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
          {others.map((r) => (
            <li key={r.path}>{row(r)}</li>
          ))}
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
    </div>
  );
}
