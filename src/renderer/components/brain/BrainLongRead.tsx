import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  isLetter,
  type BrainJob,
  type BrainPageRow,
  type BrainReads,
} from '../../../shared/brain';
import { dayKey } from '../../../shared/budget';
import { errorMessage } from '../../../shared/errors';
import { plural } from '../../../shared/text';
import { api, tryInvoke } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { useStore } from '../../store';
import { MarkdownView } from '../docs/MarkdownView';
import { trackBrain, trackReadOpen } from './brainActions';
import {
  bodyOf,
  isRead,
  newestLetter,
  splitLetter,
  splitRead,
  writeJob,
  type ReadMarks,
} from './longReads';
import { shortDay } from './recent';
import { usePageMedia } from './usePageMedia';

const NOTHING_SHOWN: ReadonlySet<string> = new Set();
/** Pages named in the out-of-date line before "and N more". */
const STALE_NAMED = 3;

/** The day a mark was set, as the reader's own day: the mark holds a UTC timestamp. */
const readOn = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : shortDay(dayKey(d));
};

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
  // The button that had the focus is gone once the answer shows: the answer takes it, so the keyboard reads on.
  const answerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown) answerRef.current?.focus({ preventScroll: true });
  }, [shown]);
  return (
    <aside className="brain-read-question" aria-label="Before you read on">
      <span className="brain-read-label">Before you read on</span>
      {render(question)}
      {shown ? (
        <div className="brain-read-answer" ref={answerRef} tabIndex={-1}>
          <span className="brain-read-label">Answer</span>
          {render(answer)}
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            trackBrain('read-answer');
            setShown(true);
          }}
        >
          Show the answer
        </button>
      )}
    </aside>
  );
}

/**
 * A long read or a letter, set for reading: a serif column, its title with reading time and day, the essay with its
 * question (answer held back) and the writer's gaps in a closed box; a letter as its labelled sections, what was read
 * struck through. A long read that is out of date says which pages changed, with Update; each links to the other.
 * Read is a mark the reader sets, for this text.
 */
export function BrainLongRead({
  brainId,
  path,
  anchor,
  reads,
  rows,
  marks,
  onMark,
  jobs,
  canWrite,
  canBack,
  canForward,
  onOpen,
  onBack,
  onForward,
  onList,
}: {
  brainId: string;
  path: string;
  anchor?: string;
  reads: BrainReads;
  /** The wiki pages, for the titles of the ones that changed. */
  rows: BrainPageRow[];
  marks: ReadMarks;
  onMark: (row: { path: string; hash: string }, read: boolean) => void;
  jobs: BrainJob[];
  /** False when the brain's skills cannot write long reads (`writeReady`). */
  canWrite: boolean;
  canBack: boolean;
  canForward: boolean;
  onOpen: (path: string, anchor?: string) => void;
  onBack: () => void;
  onForward: () => void;
  /** Back to the list of long reads. */
  onList: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { asset, openFile, onBodyClick, lightbox } = usePageMedia(brainId);
  const letter = isLetter(path);
  const read = letter ? null : reads.reads.find((r) => r.path === path);
  const letterRow = letter ? reads.letters.find((l) => l.path === path) : null;
  const row = read ?? letterRow ?? null;

  // Only the answer for the path shown lands, as in BrainPage.
  const shown = useRef(path);
  shown.current = path;
  const load = useCallback(() => {
    const p = path;
    setError(null);
    api()
      .invoke('brain:read', brainId, p)
      .then(
        (r) => {
          if (shown.current === p) setText(r.text);
        },
        (e: unknown) => {
          if (shown.current !== p) return;
          setText(null);
          setError(errorMessage(e));
        },
      );
  }, [brainId, path]);
  useEffect(() => {
    setText(null);
    load();
  }, [load]);
  useBrainChanged(brainId, load);
  useEffect(() => {
    trackReadOpen(letter ? 'letter' : 'read');
  }, [path, letter]);

  // A new read starts at its top; an anchor's heading scrolls into view. Once per navigation, not per refetch.
  const top = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (text === null) return;
    const key = `${path}#${anchor ?? ''}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    const el = anchor ? document.getElementById(anchor) : top.current;
    el?.scrollIntoView?.({ block: 'start' });
  }, [text, anchor, path]);

  const body = useMemo(() => (text === null ? null : bodyOf(text)), [text]);
  const essay = useMemo(
    () => (body === null || letter ? null : splitRead(body)),
    [body, letter],
  );
  const told = useMemo(
    () => (body === null || !letter ? null : splitLetter(body)),
    [body, letter],
  );
  const md = (t: string) => (
    <MarkdownView
      asset={asset}
      path={path}
      text={t}
      onOpenDoc={onOpen}
      onOpenFile={openFile}
      figures={{ shown: NOTHING_SHOWN }}
    />
  );

  const titleOf = (p: string) => rows.find((r) => r.path === p)?.title ?? p;
  const title = row?.title ?? path.split('/').pop() ?? path;
  const about = letterRow
    ? reads.reads.find((r) => r.path === letterRow.read)
    : null;
  const latest = read ? newestLetter(reads, read.path) : undefined;
  const update = read ? writeJob(jobs, read.path) : null;
  const done = row ? isRead(marks, row) : false;
  const mark = row && marks[row.path];
  const runUpdate = () => {
    trackBrain('read-update');
    void tryInvoke(() => api().invoke('brain:write', brainId, path), notify);
  };

  return (
    <div className="brain-page brain-longread">
      <div className="brain-page-bar" ref={top}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label="Back"
          disabled={!canBack}
          onClick={onBack}
        >
          ‹ Back
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label="Forward"
          disabled={!canForward}
          onClick={onForward}
        >
          Forward ›
        </button>
        <span className="brain-crumbs muted small" aria-label="Location">
          <button type="button" className="link" onClick={onList}>
            Long reads
          </button>
          {' › '}
          {letter && 'Letters › '}
          <span>{title}</span>
        </span>
      </div>
      {error && <p className="brain-error small">{error}</p>}
      {text === null && !error && <p className="muted small">Loading</p>}
      {text !== null && (
        <section className="brain-read-column" aria-label={title}>
          <header className="brain-read-head">
            <span className="brain-read-label">
              {letter ? 'Letter' : 'Long read'}
              {read?.chapter && ` · ${read.chapter}`}
            </span>
            <h2>{title}</h2>
            {read?.summary && <p className="brain-read-lead">{read.summary}</p>}
            <p className="brain-read-meta muted">
              {row && `${row.minutes} min`}
              {row?.written && ` · written ${shortDay(row.written)}`}
              {read?.topic && ` · asked: ${read.topic}`}
            </p>
            {about && (
              <p className="brain-read-meta">
                About{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => onOpen(about.path)}
                >
                  {about.title}
                </button>
              </p>
            )}
            {latest && (
              <p className="brain-read-meta">
                Changed {shortDay(latest.written)}:{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => onOpen(latest.path)}
                >
                  {latest.title}
                </button>
                {!isRead(marks, latest) && (
                  <>
                    {' '}
                    <span
                      className="brain-dot"
                      role="img"
                      aria-label="unread"
                    />
                  </>
                )}
              </p>
            )}
          </header>
          {read && read.stale.length > 0 && (
            <div
              className="brain-read-stale small"
              role="status"
              aria-label="Out of date"
            >
              <span className="grow">
                {plural(read.stale.length, 'page')} changed since this was
                written:{' '}
                {read.stale.slice(0, STALE_NAMED).map((p, i) => (
                  <span key={p}>
                    {i > 0 && ', '}
                    <button
                      type="button"
                      className="link"
                      onClick={() => onOpen(p)}
                    >
                      {titleOf(p)}
                    </button>
                  </span>
                ))}
                {read.stale.length > STALE_NAMED &&
                  ` and ${read.stale.length - STALE_NAMED} more`}
                {update?.job.status === 'failed' &&
                  '. The last update failed, see Activity in Add.'}
              </span>
              {canWrite && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={update?.pending}
                  onClick={runUpdate}
                >
                  {update?.pending ? 'Updating…' : 'Update'}
                </button>
              )}
            </div>
          )}
          <div className="brain-read-body" onClick={onBodyClick}>
            {essay?.parts.map((p, i) =>
              p.kind === 'prose' ? (
                <div key={i}>{md(p.text)}</div>
              ) : (
                <Question
                  key={`${path}:${i}`}
                  question={p.question}
                  answer={p.answer}
                  render={md}
                />
              ),
            )}
            {essay?.missing && (
              <details className="brain-read-missing">
                <summary>What the writer was missing</summary>
                {md(essay.missing)}
              </details>
            )}
            {told?.opening && md(told.opening)}
            {told?.changes.map((c, i) => (
              <section key={i} className="brain-letter-change">
                {c.title && <h3>{c.title}</h3>}
                {c.intro && md(c.intro)}
                {c.sections.map((s, j) => (
                  <div
                    key={j}
                    className={`brain-letter-section is-${s.kind}`}
                    role="group"
                    aria-label={s.label}
                  >
                    <span className="brain-read-label">{s.label}</span>
                    {md(s.text)}
                  </div>
                ))}
              </section>
            ))}
          </div>
          {row && (
            <footer className="brain-read-foot">
              {done ? (
                <>
                  <span className="muted">
                    Read{mark ? ` on ${readOn(mark.at)}` : ''}
                  </span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => onMark(row, false)}
                  >
                    Mark unread
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    trackBrain('read-mark');
                    onMark(row, true);
                  }}
                >
                  Mark as read
                </button>
              )}
            </footer>
          )}
        </section>
      )}
      {lightbox}
    </div>
  );
}
