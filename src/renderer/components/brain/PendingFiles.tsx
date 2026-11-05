import type { SourceType } from '../../../shared/brain';
import { SOURCE_TYPES, type BrainDrop } from './useBrainDrop';

export const NOTE_HINT = 'What is this? What matters, what is outdated?';

/**
 * The files dropped on a brain, waiting to go in: a type and a note per file, then one Add for all of them. The
 * note lands in the source's frontmatter and steers the capture; the files are captured as soon as they are added.
 */
export function PendingFiles({ drop }: { drop: BrainDrop }) {
  const { pending, adding, setType, setNote, remove, add } = drop;
  if (pending.length === 0) return null;
  const n = pending.length;
  return (
    <form
      className="brain-pending"
      aria-label="Files to add"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <ul className="list">
        {pending.map((f) => (
          <li key={f.path} className="list-row brain-pending-row">
            <span className="brain-pending-name" title={f.path}>
              {f.name}
            </span>
            <select
              className="field"
              aria-label={`Type of ${f.name}`}
              value={f.type}
              disabled={adding}
              onChange={(e) => setType(f.path, e.target.value as SourceType)}
            >
              {SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              className="field brain-pending-note"
              aria-label={`Note for ${f.name}`}
              placeholder={NOTE_HINT}
              value={f.note}
              disabled={adding}
              onChange={(e) => setNote(f.path, e.target.value)}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={`Remove ${f.name}`}
              disabled={adding}
              onClick={() => remove(f.path)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="brain-pending-actions">
        <button type="submit" className="btn btn-sm" disabled={adding}>
          {adding ? 'Adding' : n === 1 ? 'Add 1 file' : `Add ${n} files`}
        </button>
        <span className="muted small">
          The note goes with the file and steers its capture.
        </span>
      </div>
    </form>
  );
}
