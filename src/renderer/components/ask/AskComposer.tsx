import { Dismiss12Regular } from '@fluentui/react-icons';
import { type Ref, type TextareaHTMLAttributes, useId } from 'react';

const MIN_ROWS = 2;
const MAX_ROWS = 8;

/**
 * The box an ask is written in, the same wherever Shellie takes one: Enter sends, Shift+Enter starts a new line,
 * and the box grows with its lines. While a run is under way (`waiting`) it stays usable and sends nothing, so
 * what is typed is kept; `off` disables it with the reason.
 */
export function AskComposer({
  value,
  onChange,
  onSend,
  label,
  hint = null,
  quote = null,
  onQuoteRemove,
  off = null,
  waiting = null,
  sending = false,
  maxLength,
  primary = false,
  boxRef,
  boxProps,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  /** The box's name and placeholder. */
  label: string;
  /** Shown under an empty box. */
  hint?: string | null;
  /** The selected text the ask is about. */
  quote?: string | null;
  onQuoteRemove?: () => void;
  /** Why nothing can be asked here now. */
  off?: string | null;
  /** A run is under way: the sentence that says so. */
  waiting?: string | null;
  /** The send call is in flight. */
  sending?: boolean;
  maxLength?: number;
  /** The button is the page's primary one. */
  primary?: boolean;
  boxRef?: Ref<HTMLTextAreaElement>;
  boxProps?: Pick<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    'onMouseDown' | 'onFocus'
  >;
}) {
  const id = useId();
  const under = off ?? waiting ?? (value === '' ? hint : null);
  const blocked = off !== null || waiting !== null || sending;
  const canSend = !blocked && value.trim() !== '';
  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, value.split('\n').length));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && quote && onQuoteRemove) {
      e.preventDefault();
      e.stopPropagation();
      onQuoteRemove();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (canSend) onSend();
  };

  return (
    <div className="ask-box">
      {quote && (
        <p className="small ask-chip">
          <span className="ask-chip-text">{`About: “${quote}”`}</span>
          <button
            type="button"
            className="ibtn ask-chip-x"
            aria-label="Remove the selected text from the ask"
            onClick={onQuoteRemove}
          >
            <Dismiss12Regular aria-hidden="true" />
          </button>
        </p>
      )}
      <textarea
        ref={boxRef}
        className="ask-box-text"
        rows={rows}
        aria-label={label}
        aria-describedby={under ? `${id}-under` : undefined}
        placeholder={label}
        maxLength={maxLength}
        disabled={off !== null}
        readOnly={sending}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        {...boxProps}
      />
      <div className="ask-box-foot">
        <span id={`${id}-under`} className="muted small">
          {under}
        </span>
        <button
          type="button"
          className={primary ? 'btn btn-primary' : 'btn'}
          disabled={!canSend}
          onClick={onSend}
        >
          Ask
        </button>
      </div>
    </div>
  );
}
