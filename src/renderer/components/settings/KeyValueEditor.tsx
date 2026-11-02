import { Add16Regular, Dismiss16Regular } from '@fluentui/react-icons';
import { type FocusEvent, type KeyboardEvent, useRef, useState } from 'react';
import { IconButton } from '../ui/IconButton';

/** One key/value pair; Enter or leaving the row commits, Escape reverts. */
function PairRow({
  k,
  v,
  keyLabel,
  valueLabel,
  autoFocus,
  error,
  onCommit,
  onCancel,
  onRemove,
}: {
  k: string;
  v: string;
  keyLabel: string;
  valueLabel: string;
  autoFocus?: boolean;
  error?: string | null;
  onCommit: (key: string, value: string) => boolean;
  onCancel?: () => void;
  onRemove?: () => void;
}) {
  const [key, setKey] = useState(k);
  const [value, setValue] = useState(v);
  const [err, setErr] = useState<string | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const commit = () => {
    const ok = onCommit(key.trim(), value);
    setErr(ok ? null : `${keyLabel} "${key.trim()}" is already used`);
  };
  const revert = () => {
    setKey(k);
    setValue(v);
    setErr(null);
    onCancel?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      revert();
    }
  };
  const onBlur = (e: FocusEvent) => {
    if (row.current?.contains(e.relatedTarget as Node | null)) return;
    if (key.trim() === k && value === v) return;
    commit();
  };
  return (
    <div className="kv-row-wrap">
      <div className="list-editor-row" ref={row} onBlur={onBlur}>
        <input
          className="input mono"
          aria-label={keyLabel}
          value={key}
          autoFocus={autoFocus}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={onKey}
        />
        <input
          className="input mono"
          aria-label={valueLabel}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
        />
        {onRemove ? (
          <IconButton label={`Remove ${k}`} onClick={onRemove}>
            <Dismiss16Regular />
          </IconButton>
        ) : null}
      </div>
      {err || error ? (
        <div className="field-error" role="alert">
          {err ?? error}
        </div>
      ) : null}
    </div>
  );
}

/** Edits a string-to-string map as rows. A key that already exists is refused with an inline error. */
export function KeyValueEditor({
  label,
  value,
  onChange,
  keyLabel,
  valueLabel,
}: {
  label: string;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyLabel: string;
  valueLabel: string;
}) {
  const [adding, setAdding] = useState(false);
  const entries = Object.entries(value);
  return (
    <div className="list-editor" role="group" aria-label={label}>
      {entries.map(([k, v]) => (
        <PairRow
          key={`${k}=${v}`}
          k={k}
          v={v}
          keyLabel={keyLabel}
          valueLabel={valueLabel}
          onRemove={() =>
            onChange(Object.fromEntries(entries.filter(([x]) => x !== k)))
          }
          onCommit={(nk, nv) => {
            if (!nk) {
              onChange(Object.fromEntries(entries.filter(([x]) => x !== k)));
              return true;
            }
            if (nk !== k && nk in value) return false;
            onChange(
              Object.fromEntries(
                entries.map(([x, y]) => (x === k ? [nk, nv] : [x, y])),
              ),
            );
            return true;
          }}
        />
      ))}
      {adding ? (
        <PairRow
          k=""
          v=""
          keyLabel={keyLabel}
          valueLabel={valueLabel}
          autoFocus
          onCancel={() => setAdding(false)}
          onCommit={(nk, nv) => {
            if (!nk) {
              setAdding(false);
              return true;
            }
            if (nk in value) return false;
            setAdding(false);
            onChange({ ...value, [nk]: nv });
            return true;
          }}
        />
      ) : (
        <button
          type="button"
          className="btn btn-subtle list-editor-add"
          onClick={() => setAdding(true)}
        >
          <Add16Regular /> Add item
        </button>
      )}
    </div>
  );
}
