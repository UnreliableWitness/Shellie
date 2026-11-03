import { useState, type DragEvent } from 'react';
import type { BrainJob, BrainView, SourceType } from '../../../shared/brain';
import type { AddSourceResult } from '../../../shared/brain';
import type { TerminalDef } from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import { useStore } from '../../store';
import { openBrainTerminal, trackBrain } from './brainActions';

/** The same rule as main's `guessSourceType`: by extension, not by content. */
export const guessType = (name: string): SourceType =>
  /\.vtt$/i.test(name) ? 'transcript' : /\.pptx$/i.test(name) ? 'deck' : 'doc';

const TYPES: SourceType[] = ['doc', 'note', 'transcript', 'deck', 'sow'];

const failures = (results: AddSourceResult[]) =>
  results.flatMap((r) => (r.ok ? [] : [r.message]));

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
      </div>
      <span className={`brain-status brain-status-${job.status} small`}>
        {job.status}
      </span>
      {(job.status === 'failed' || job.status === 'paused') && (
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

/** What goes into the brain: dropped files, pasted text, and the capture jobs they queue. */
export function BrainInbox({
  brain,
  onTerminal,
}: {
  brain: BrainView;
  onTerminal?: (def: TerminalDef) => void;
}) {
  const notify = useStore((s) => s.notify);
  const [over, setOver] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [type, setType] = useState<SourceType>('note');

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    trackBrain('drop');
    const rows = files.map((f) => ({
      path: api().pathForFile(f),
      type: guessType(f.name),
    }));
    const results = await tryInvoke(
      () => api().invoke('brain:addFiles', brain.id, rows),
      notify,
    );
    setProblems(results ? failures(results) : []);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void addFiles(Array.from(e.dataTransfer.files));
  };
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
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span>Drop files here</span>
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
