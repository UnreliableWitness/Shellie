import {
  Add16Regular,
  ArrowDown16Regular,
  ArrowUp16Regular,
  Dismiss16Regular,
} from '@fluentui/react-icons';
import { type KeyboardEvent, useState } from 'react';
import { IconButton } from '../ui/IconButton';

/** An input that edits a draft: Enter or blur commits, Escape puts the old value back. */
function ItemInput({
  value,
  label,
  placeholder,
  mono,
  autoFocus,
  onCommit,
  onCancel,
}: {
  value: string;
  label: string;
  placeholder?: string;
  mono?: boolean;
  autoFocus?: boolean;
  onCommit: (v: string) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [done, setDone] = useState(false);
  const finish = (commit: boolean) => {
    if (done) return;
    setDone(true);
    if (commit) onCommit(draft.trim());
    else {
      setDraft(value);
      onCancel?.();
    }
    // the same input can be used again after a commit
    queueMicrotask(() => setDone(false));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  };
  return (
    <input
      className={`input${mono ? ' mono' : ''}`}
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      autoFocus={autoFocus}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => finish(true)}
    />
  );
}

/** VS Code's list widget: edit in place, remove, move, add. Empty items are dropped. */
export function ListEditor({
  label,
  items,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const move = (i: number, by: number) => {
    const next = [...items];
    const [it] = next.splice(i, 1);
    next.splice(i + by, 0, it);
    onChange(next);
  };
  return (
    <div className="list-editor" role="group" aria-label={label}>
      {items.map((item, i) => (
        <div className="list-editor-row" key={`${i}:${item}`}>
          <ItemInput
            value={item}
            label={`${label} item ${i + 1}`}
            placeholder={placeholder}
            mono={mono}
            onCommit={(v) => {
              if (v === item) return;
              onChange(
                v
                  ? items.map((x, j) => (j === i ? v : x))
                  : items.filter((_, j) => j !== i),
              );
            }}
          />
          <IconButton
            label={`Move ${item} up`}
            disabled={i === 0}
            onClick={() => move(i, -1)}
          >
            <ArrowUp16Regular />
          </IconButton>
          <IconButton
            label={`Move ${item} down`}
            disabled={i === items.length - 1}
            onClick={() => move(i, 1)}
          >
            <ArrowDown16Regular />
          </IconButton>
          <IconButton
            label={`Remove ${item}`}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            <Dismiss16Regular />
          </IconButton>
        </div>
      ))}
      {adding ? (
        <div className="list-editor-row">
          <ItemInput
            value=""
            label={`New ${label} item`}
            placeholder={placeholder}
            mono={mono}
            autoFocus
            onCommit={(v) => {
              setAdding(false);
              if (v) onChange([...items, v]);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
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
