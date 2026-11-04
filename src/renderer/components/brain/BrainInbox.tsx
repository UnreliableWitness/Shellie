import { useCallback, useEffect, useState } from 'react';
import type {
  BrainJob,
  BrainSourceRow,
  BrainView,
  SourceType,
} from '../../../shared/brain';
import type { TerminalDef } from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { useStore } from '../../store';
import { openBrainTerminal, trackBrain } from './brainActions';
import { useBrainDrop } from './useBrainDrop';

export { guessType } from './useBrainDrop';

const TYPES: SourceType[] = ['doc', 'note', 'transcript', 'deck', 'sow'];

const newestFirst = (jobs: BrainJob[]) =>
  [...jobs].sort((a, b) =>
    (b.startedAt ?? '9').localeCompare(a.startedAt ?? '9'),
  );

function JobRow({
  brain,
  job,
  onTerminal,
}: {
  brain: BrainView;
  job: BrainJob;
  onTerminal?: (def: TerminalDef) => void;
}) {
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
    const def = await openBrainTerminal(brain.id, notify, job.sessionId);
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

/** Sources not captured yet (the wiki mirror's pages are synced, not captured), each with a Capture button. */
function SourcesToCapture({ brain }: { brain: BrainView }) {
  const notify = useStore((s) => s.notify);
  const [rows, setRows] = useState<BrainSourceRow[]>([]);
  const load = useCallback(() => {
    api()
      .invoke('brain:sources', brain.id)
      .then(setRows, () => undefined);
  }, [brain.id]);
  useEffect(load, [load]);
  useBrainChanged(brain.id, load);
  const pending = rows.filter(
    (r) => !r.captured && !r.path.startsWith('sources/wiki/'),
  );
  if (pending.length === 0) return null;
  // A capture already queued or running for the source is not offered again.
  const queued = new Set(
    brain.jobs
      .filter((j) => j.status === 'queued' || j.status === 'running')
      .map((j) => j.source),
  );
  const capture = (path: string) => {
    trackBrain('capture');
    void tryInvoke(
      () => api().invoke('brain:run', brain.id, 'capture', path),
      notify,
    );
  };
  return (
    <>
      <h3>Sources to capture</h3>
      <ul className="list brain-uncaptured" aria-label="Sources to capture">
        {pending.map((r) => (
          <li key={r.path} className="list-row">
            <span className="grow">
              {r.path} <span className="muted small">{r.type}</span>
              {r.contents && (
                <span className="muted small brain-contents">{r.contents}</span>
              )}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              aria-label={`Capture ${r.path}`}
              disabled={queued.has(r.path)}
              onClick={() => capture(r.path)}
            >
              Capture
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** What goes into the brain: dropped files, pasted text, and the capture jobs they queue. */
export function BrainInbox({
  brain,
  onTerminal,
}: {
  brain: BrainView;
  onTerminal?: (def: TerminalDef) => void;
}) {
  const notify = useStore((s) => s.notify);
  const { over, problems, setProblems, notes, addFiles, dropProps } =
    useBrainDrop(brain.id);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [type, setType] = useState<SourceType>('note');

  const paste = async () => {
    trackBrain('paste');
    const result = await tryInvoke(
      () => api().invoke('brain:addText', brain.id, text, title.trim(), type),
      notify,
    );
    if (!result) return;
    if (result.ok) {
      setText('');
      setTitle('');
      setProblems([]);
    } else setProblems([result.message]);
  };

  return (
    <section className="brain-card" aria-labelledby="brain-inbox-h">
      <h2 id="brain-inbox-h">Inbox</h2>
      <div
        data-dropzone
        className={over ? 'brain-drop is-over' : 'brain-drop'}
        {...dropProps}
      >
        <span>Drop files here</span>
        <span className="muted small">
          PDF, Word, PowerPoint, Excel, draw.io, VTT transcripts, Markdown, text
        </span>
        <label className="btn btn-sm">
          Choose files
          <input
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </label>
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
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
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
      {problems.length > 0 && (
        <ul className="brain-problems small" role="alert">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {notes.length > 0 && (
        <ul className="brain-notes muted small" aria-label="Added">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <SourcesToCapture brain={brain} />
      {brain.jobs.length === 0 ? (
        <p className="muted small">No jobs yet.</p>
      ) : (
        <ul className="list brain-jobs">
          {newestFirst(brain.jobs).map((j) => (
            <JobRow key={j.id} brain={brain} job={j} onTerminal={onTerminal} />
          ))}
        </ul>
      )}
    </section>
  );
}
