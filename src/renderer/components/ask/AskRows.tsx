import { type ReactNode, type Ref, useEffect, useState } from 'react';
import type { AskProgress } from '../../../shared/askProgress';
import { AskSteps } from './AskSteps';
import { tookWords } from './askWords';

/** The time since `startedAt`, counted while mounted. */
export function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{tookWords(Math.max(0, now - startedAt))}</>;
}

/**
 * A run under way: what the agent did so far (when it says), what the surface shows of the answer (`children`),
 * then what it is doing in a word, for how long, and Stop.
 */
export function AskWorking({
  word,
  startedAt,
  onStop,
  stopOff = false,
  focusRef,
  progress,
  children,
}: {
  word: 'Working' | 'Answering';
  startedAt: number;
  onStop: () => void;
  stopOff?: boolean;
  /** Takes the focus when the run starts where the box had it. */
  focusRef?: Ref<HTMLParagraphElement>;
  progress?: AskProgress;
  children?: ReactNode;
}) {
  return (
    <>
      {progress && (
        <AskSteps steps={progress.steps} earlier={progress.earlier} />
      )}
      {children}
      <div className="ask-working">
        <span className="dot ask-working-dot" aria-hidden="true" />
        {/* Only the word is said, once: a live region around the counting time would speak every second. */}
        <p ref={focusRef} tabIndex={-1} className="muted small">
          <span role="status">{word}</span> · <Elapsed startedAt={startedAt} />
        </p>
        <button
          type="button"
          className="btn btn-sm"
          disabled={stopOff}
          onClick={onStop}
        >
          Stop
        </button>
      </div>
    </>
  );
}

/** A run the person stopped: their choice, so not an error. */
export function AskStopped({
  afterMs,
  onAgain,
  againOff = false,
}: {
  /** How long it ran; null when that is not known. */
  afterMs: number | null;
  onAgain: () => void;
  againOff?: boolean;
}) {
  return (
    <div className="ask-strip">
      <span>
        {afterMs === null
          ? 'Stopped. Nothing was changed.'
          : `Stopped after ${tookWords(afterMs)}. Nothing was changed.`}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={againOff}
        onClick={onAgain}
      >
        Ask again
      </button>
    </div>
  );
}

/** A run that could not finish: the reason, Try again, and the way to the cause when Shellie knows one. */
export function AskFailed({
  reason,
  onRetry,
  retryOff = false,
  second,
}: {
  reason: string;
  onRetry: () => void;
  retryOff?: boolean;
  second?: { label: string; run: () => void };
}) {
  return (
    <div className="ask-strip is-failed">
      <p role="alert">
        <strong>Could not finish.</strong> {reason}
      </p>
      <div className="ask-strip-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={retryOff}
          onClick={onRetry}
        >
          Try again
        </button>
        {second && (
          <button type="button" className="btn btn-sm" onClick={second.run}>
            {second.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** The small line under a finished ask: what is known of it, joined. */
export function AskFoot({ parts }: { parts: (string | null | false)[] }) {
  const shown = parts.filter((p): p is string => !!p);
  if (shown.length === 0) return null;
  return <p className="ask-foot muted small">{shown.join(' · ')}</p>;
}
