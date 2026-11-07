import { useEffect, useRef, useState } from 'react';
import type {
  BrainJob,
  BrainPageRow,
  BrainSourceRow,
  BrainView,
  SourceType,
} from '../../../shared/brain';
import type { TerminalDef } from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import { useStore } from '../../store';
import { HelpTip } from '../ui';
import { openBrainTerminal, trackBrain } from './brainActions';
import { AddedNotes, NOTE_HINT, PendingFiles } from './PendingFiles';
import { pagesChangedBy } from './recent';
import { SOURCE_TYPES, type BrainDrop } from './useBrainDrop';
import { captureInFlight, waitingSources, waitReason } from './waiting';

export { guessType } from './useBrainDrop';

const newestFirst = (jobs: BrainJob[]) =>
  [...jobs].sort((a, b) =>
    (b.startedAt ?? '9').localeCompare(a.startedAt ?? '9'),
  );

function JobRow({
  brain,
  job,
  changed,
  onTerminal,
  onOpenPage,
}: {
  brain: BrainView;
  job: BrainJob;
  /** The pages a done capture changed, from log.md; empty for any other job. */
  changed: { label: string; path: string | null }[];
  onTerminal?: (def: TerminalDef) => void;
  onOpenPage: (path: string) => void;
}) {
  const first = changed.find((p) => p.path)?.path;
  const notify = useStore((s) => s.notify);
  const retry = () => {
    trackBrain('retry');
    void tryInvoke(
      () =>
        job.source
          ? api().invoke('brain:run', brain.id, job.kind, job.source)
          : api().invoke('brain:run', brain.id, job.kind),
      notify,
    );
  };
  const resume = async () => {
    trackBrain('continue');
    // A job that ran on the other agent than the brain now has continues on its own agent.
    const def = await openBrainTerminal(
      brain.id,
      notify,
      job.sessionId,
      undefined,
      job.agent === brain.options.agent ? undefined : job.agent,
    );
    if (def) onTerminal?.(def);
  };
  return (
    <li className="list-row brain-job">
      <div className="grow">
        <span>
          <strong>{job.kind}</strong>
          {job.source && <span className="muted"> {job.source}</span>}
        </span>
        {job.error && <span className="brain-error small">{job.error}</span>}
        {job.status === 'done' && job.result && (
          <details className="brain-takeaways small">
            <summary>Takeaways</summary>
            <p>{job.result}</p>
          </details>
        )}
      </div>
      {first && (
        <button
          type="button"
          className="link small"
          onClick={() => onOpenPage(first)}
        >
          {changed.length === 1
            ? '1 page changed'
            : `${changed.length} pages changed`}
        </button>
      )}
      <span className={`brain-status brain-status-${job.status} small`}>
        {job.status}
      </span>
      {/* A paused job runs again on Resume (Health); only a failed one is retried. */}
      {job.status === 'failed' && (
        <button type="button" className="btn btn-sm" onClick={retry}>
          Retry
        </button>
      )}
      {job.sessionId && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void resume()}
        >
          Continue in terminal
        </button>
      )}
    </li>
  );
}

/** The drop zone and the paste form; `drop` comes from the view, whose root is the drop target. */
export function AddToBrain({
  brain,
  drop,
  focusChoose = false,
}: {
  brain: BrainView;
  drop: BrainDrop;
  /** Put the cursor on Choose files once mounted (a deep link to the drop zone). */
  focusChoose?: boolean;
}) {
  const chooseRef = useRef<HTMLLabelElement>(null);
  useEffect(() => {
    if (focusChoose) chooseRef.current?.focus();
  }, [focusChoose]);
  const notify = useStore((s) => s.notify);
  const { over, problems, setProblems, added, addFiles } = drop;
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [type, setType] = useState<SourceType>('note');
  const [note, setNote] = useState('');

  const paste = async () => {
    trackBrain('paste');
    const n = note.trim();
    const result = await tryInvoke(
      () =>
        n
          ? api().invoke('brain:addText', brain.id, text, title.trim(), type, n)
          : api().invoke('brain:addText', brain.id, text, title.trim(), type),
      notify,
    );
    if (!result) return;
    if (result.ok) {
      setText('');
      setTitle('');
      setNote('');
      setProblems([]);
    } else setProblems([result.message]);
  };

  return (
    <section className="brain-card" aria-labelledby="brain-add-h">
      <h2 id="brain-add-h">Add to the brain</h2>
      <div className="brain-dropzone">
        <div
          data-dropzone
          className={over ? 'brain-drop is-over' : 'brain-drop'}
        >
          <span>Drop files here</span>
          <span className="muted small">
            PDF, Word, PowerPoint, Excel, draw.io, VTT transcripts, Markdown,
            text
          </span>
          <label className="btn btn-sm" ref={chooseRef} tabIndex={-1}>
            Choose files
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <PendingFiles drop={drop} />
      </div>
      <form
        className="brain-paste"
        onSubmit={(e) => {
          e.preventDefault();
          void paste();
        }}
      >
        <input
          className="field"
          aria-label="Title"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <select
          className="field"
          aria-label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as SourceType)}
        >
          {SOURCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="field brain-paste-note"
          aria-label="Note"
          placeholder={NOTE_HINT}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <textarea
          className="field"
          aria-label="Text"
          placeholder="Paste notes or text"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-sm"
          disabled={text.trim() === ''}
        >
          Add
        </button>
      </form>
      <p className="muted small">Captured automatically after you add it.</p>
      {problems.length > 0 && (
        <ul className="brain-problems small" role="alert">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <AddedNotes brainId={brain.id} added={added} jobs={brain.jobs} />
    </section>
  );
}

/** Sources not captured yet (the wiki mirror's pages are synced, not captured), each with why it waits and Capture. */
export function WaitingToCapture({
  brain,
  sources,
}: {
  brain: BrainView;
  sources: BrainSourceRow[];
}) {
  const notify = useStore((s) => s.notify);
  const waiting = waitingSources(sources);
  if (waiting.length === 0) return null;
  const paused = brain.health?.queuePaused ?? null;
  const rows = waiting.map((r) => ({
    ...r,
    reason: waitReason(r.path, brain.jobs, paused),
    busy: captureInFlight(r.path, brain.jobs),
  }));
  // A capture already in flight for the source is not offered again.
  const run = (path: string) =>
    tryInvoke(
      () => api().invoke('brain:run', brain.id, 'capture', path),
      notify,
    );
  const capture = (path: string) => {
    trackBrain('capture');
    void run(path);
  };
  const captureAll = () => {
    trackBrain('capture');
    for (const r of rows) if (!r.busy) void run(r.path);
  };
  // The heading counts what waits for you, the same number as the Add badge; captures in flight are only listed.
  const inFlight = rows.filter((r) => r.busy).length;
  const forYou = rows.length - inFlight;
  return (
    <section className="brain-card" aria-labelledby="brain-waiting-h">
      <div className="brain-card-head">
        <h2 id="brain-waiting-h">
          Waiting to capture{forYou > 0 && ` · ${forYou}`}
        </h2>
        {inFlight > 0 && (
          <span className="muted small">{inFlight} capturing</span>
        )}
        <HelpTip label="Waiting to capture">
          Dropped and pasted sources are captured automatically; while that
          runs, or while the daily token cap holds the queue, they are listed
          here as queued or capturing. The number counts the rest, the ones that
          wait for you: a capture that failed, or a file put in the folder by
          hand. The Add badge shows the same number.
        </HelpTip>
        <button
          type="button"
          className="btn btn-sm brain-card-action"
          disabled={rows.every((r) => r.busy)}
          onClick={captureAll}
        >
          Capture all
        </button>
      </div>
      <ul className="list brain-uncaptured" aria-label="Waiting to capture">
        {rows.map((r) => (
          <li key={r.path} className="list-row">
            <span className="grow">
              {r.path.split('/').pop()}{' '}
              <span className="muted small">{r.type}</span>{' '}
              <span
                className={
                  r.reason.kind === 'failed'
                    ? 'brain-error small'
                    : 'muted small'
                }
              >
                {r.reason.text}
              </span>
              {r.contents && (
                <span className="muted small brain-contents">{r.contents}</span>
              )}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              aria-label={`Capture ${r.path}`}
              disabled={r.busy}
              onClick={() => capture(r.path)}
            >
              Capture
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The brain's jobs this session, newest first; a done capture links to the pages it changed. */
export function RecentWork({
  brain,
  rows,
  log,
  onTerminal,
  onOpenPage,
}: {
  brain: BrainView;
  rows: BrainPageRow[];
  log: string;
  onTerminal?: (def: TerminalDef) => void;
  onOpenPage: (path: string) => void;
}) {
  return (
    <section className="brain-card" aria-labelledby="brain-recent-h">
      <h2 id="brain-recent-h">Recent work</h2>
      {brain.jobs.length === 0 ? (
        <p className="muted small">No jobs yet.</p>
      ) : (
        <ul className="list brain-jobs" aria-label="Recent work">
          {newestFirst(brain.jobs).map((j) => (
            <JobRow
              key={j.id}
              brain={brain}
              job={j}
              changed={pagesChangedBy(j, log, rows)}
              onTerminal={onTerminal}
              onOpenPage={onOpenPage}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
