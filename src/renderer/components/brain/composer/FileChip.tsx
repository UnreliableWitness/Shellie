import { Dismiss16Regular } from '@fluentui/react-icons';
import type { SourceType } from '../../../../shared/brain';
import { SOURCE_TYPES } from '../useBrainDrop';
import type { DraftFile } from './draft';
import { fileKind, type FileKind } from './text';

const BADGE: Record<FileKind, string> = {
  pdf: 'PDF',
  word: 'DOC',
  deck: 'PPT',
  sheet: 'XLS',
  drawio: 'DIO',
  transcript: 'VTT',
  text: 'TXT',
  picture: 'IMG',
  other: 'FILE',
};

/** 412 KB, 3.1 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** One attached file: its kind, name and size, its type, and an Own note when it needs one other than the shared note. */
export function FileChip({
  file,
  disabled,
  onType,
  onOwnNote,
  onRemove,
}: {
  file: DraftFile;
  disabled: boolean;
  onType(type: SourceType): void;
  /** null takes the shared note again. */
  onOwnNote(note: string | null): void;
  onRemove(): void;
}) {
  const kind = fileKind(file.name);
  return (
    <div className="brain-chip" role="group" aria-label={file.name}>
      <div className="brain-chip-row">
        <span className={`brain-chip-kind is-${kind}`} aria-hidden="true">
          {BADGE[kind]}
        </span>
        <span className="brain-chip-name">
          <span className="brain-chip-title" title={file.path}>
            {file.name}
          </span>
          <span className="muted small">
            {formatBytes(file.bytes)}
            {file.ownNote === null && (
              <>
                {' · '}
                <button
                  type="button"
                  className="link small"
                  disabled={disabled}
                  onClick={() => onOwnNote('')}
                >
                  Own note
                </button>
              </>
            )}
          </span>
        </span>
        <select
          className="field brain-pill"
          aria-label={`Type of ${file.name}`}
          value={file.type}
          disabled={disabled}
          onChange={(e) => onType(e.target.value as SourceType)}
        >
          {SOURCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-ghost btn-sm brain-chip-remove"
          aria-label={`Remove ${file.name}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Dismiss16Regular />
        </button>
      </div>
      {file.ownNote !== null && (
        <div className="brain-chip-note">
          <input
            className="field"
            aria-label={`Own note for ${file.name}`}
            placeholder="Goes with this file instead of the shared note"
            value={file.ownNote}
            disabled={disabled}
            // An Own note left empty and blurred goes back to the shared note.
            onBlur={(e) => {
              if (!e.target.value.trim()) onOwnNote(null);
            }}
            autoFocus
            onChange={(e) => onOwnNote(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
