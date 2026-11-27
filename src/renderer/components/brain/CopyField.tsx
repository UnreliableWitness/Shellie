import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../shared/errors';
import { useStore } from '../../store';

/** A value to hand to someone: shown whole in a box that selects itself on click, with Copy beside it. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const notify = useStore((s) => s.notify);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () =>
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      },
      (e: unknown) => notify('error', errorMessage(e)),
    );
  return (
    <div className="copy-field">
      <input
        className="field mono"
        aria-label={label}
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        className="btn btn-sm"
        aria-live="polite"
        onClick={() => void copy()}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
