import { Dismiss12Regular } from '@fluentui/react-icons';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import {
  DREAM_ASK_MAX,
  DREAM_QUOTE_MAX,
  type DreamProposal,
  type DreamResult,
} from '../../../shared/dreams';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';

/** An ask as it is being written: the text and the lines it is about. */
export type AskDraft = { text: string; quote: string | null };
export const NO_DRAFT: AskDraft = { text: '', quote: null };

/** How many asks show before "Earlier asks" opens the rest. */
const SHOWN = 3;

/** The sentence that says another proposal is being changed; also the reason Create pull request is off. */
export const adjustingSentence = (result: DreamResult): string | null => {
  const run = result.adjusting;
  if (!run) return null;
  const title = result.proposals.find((p) => p.id === run.proposalId)?.title;
  return title
    ? `A change to “${title}” is being made`
    : 'A change is being made';
};

/**
 * The foot of a proposal's pane: what was asked about the proposal and what came of it, and the box to ask for a
 * change (`dream:adjust`). Everything shown is the result's, so the page can be left and come back to; nothing
 * here moves by itself.
 */
export function AskBox({
  result,
  proposal: p,
  draft,
  onDraft,
  scope,
}: {
  result: DreamResult;
  proposal: DreamProposal;
  draft: AskDraft;
  onDraft: (update: (d: AskDraft) => AskDraft) => void;
  /** Where selected text counts as what an ask is about: the proposal's pane. */
  scope: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const working = useRef<HTMLParagraphElement>(null);
  // The call under way: `send`, `stop` or `undo`.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [earlier, setEarlier] = useState(false);
  // What the last ask came to, for a screen reader.
  const [said, setSaid] = useState('');

  const run = result.adjusting ?? null;
  const mine = run?.proposalId === p.id;
  const failed =
    result.adjustFailed?.proposalId === p.id ? result.adjustFailed : null;
  const asks = p.adjustments ?? [];
  const off = p.dropped
    ? 'Take the proposal back to change it'
    : run && !mine
      ? adjustingSentence(result)
      : null;
  const text = draft.text.trim();

  // The run started or ended: the focus follows what took the place of what held it, and the end is said.
  const was = useRef({ mine, count: asks.length });
  useEffect(() => {
    const before = was.current;
    was.current = { mine, count: asks.length };
    if (before.mine === mine) return;
    const at = document.activeElement;
    const free =
      !at || at === document.body || (root.current?.contains(at) ?? false);
    if (mine) {
      if (free) working.current?.focus({ preventScroll: true });
      return;
    }
    const last = asks.length > before.count ? asks[asks.length - 1] : null;
    setSaid(
      last
        ? `${last.changed ? 'Changed' : 'Answer'}: ${last.note}`
        : failed
          ? `Could not make the change: ${failed.reason}`
          : '',
    );
    if (free) box.current?.focus({ preventScroll: true });
  }, [mine, asks, failed]);

  /** The selected text when it lies in the proposal's pane and not in this foot; null otherwise. */
  const selected = (): string | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const at = sel.getRangeAt(0).commonAncestorContainer;
    if (!scope.current?.contains(at) || root.current?.contains(at)) return null;
    return sel.toString().trim().slice(0, DREAM_QUOTE_MAX).trimEnd() || null;
  };
  // A click in the box can clear the selection before the box has the focus: the last one seen is kept for it.
  const lastSelected = useRef<string | null>(null);
  const selectedNow = useRef(selected);
  useEffect(() => {
    selectedNow.current = selected;
  });
  useEffect(() => {
    const onChange = () => {
      const quote = selectedNow.current();
      if (quote) lastSelected.current = quote;
      else if (document.activeElement !== box.current)
        lastSelected.current = null;
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, []);
  const takeQuote = () => {
    const quote = selected() ?? lastSelected.current;
    lastSelected.current = null;
    if (quote) onDraft((d) => ({ ...d, quote }));
  };

  const call = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy((b) => (b === key ? null : b));
    }
  };

  const send = () => {
    if (!text || off || mine || busy) return;
    setSaid('');
    void call('send', async () => {
      await api().invoke(
        'dream:adjust',
        result.repoId,
        p.id,
        text,
        ...(draft.quote ? ([draft.quote] as const) : []),
      );
      onDraft(() => NO_DRAFT);
    });
  };

  const undo = () =>
    call('undo', async () => {
      await api().invoke('dream:adjustUndo', result.repoId, p.id);
      setSaid('The change was taken back');
      box.current?.focus({ preventScroll: true });
    });

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && draft.quote) {
      e.preventDefault();
      e.stopPropagation();
      onDraft((d) => ({ ...d, quote: null }));
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  // The newest ask that changed the proposal is the one Undo takes back.
  let undoAt = -1;
  asks.forEach((a, i) => {
    if (a.changed) undoAt = i;
  });
  const hidden = Math.max(0, asks.length - SHOWN);
  const first = earlier ? 0 : hidden;

  return (
    <div
      ref={root}
      role="group"
      aria-label="Ask for a change"
      className="dream-ask"
    >
      {hidden > 0 && (
        <button
          type="button"
          className="link small dream-ask-earlier"
          aria-expanded={earlier}
          onClick={() => setEarlier((v) => !v)}
        >
          {`Earlier asks (${hidden})`}
        </button>
      )}
      {asks.length > 0 && (
        <ol aria-label="Asks about this proposal" className="dream-asks">
          {asks.slice(first).map((a, k) => {
            const i = first + k;
            return (
              <li key={`${a.at}-${i}`} className="dream-asked">
                <p id={`${id}-ask-${i}`}>
                  <span className="muted">You: </span>
                  {a.ask}
                </p>
                {a.quote && (
                  <p className="muted small dream-ask-line">{`About: “${a.quote}”`}</p>
                )}
                <p className="dream-asked-note">
                  <span>
                    <span className="muted">
                      {a.changed ? 'Changed: ' : 'Answer: '}
                    </span>
                    {a.note}
                  </span>
                  {i === undoAt && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-describedby={`${id}-ask-${i}`}
                      disabled={run !== null || busy !== null || p.dropped}
                      onClick={() => void undo()}
                    >
                      Undo
                    </button>
                  )}
                </p>
                {a.reverted.length > 0 && (
                  <p className="text-warn small">
                    {`Left as they were: ${a.reverted.join(', ')}`}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {mine && run ? (
        <div className="dream-ask-row">
          <span className="dot dream-ask-dot" aria-hidden="true" />
          <p ref={working} tabIndex={-1} className="dream-ask-working">
            {`Working on: “${run.ask}”`}
          </p>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              void call('stop', () =>
                api().invoke('dream:adjustStop', result.repoId),
              )
            }
          >
            Stop
          </button>
        </div>
      ) : (
        <>
          {draft.quote && (
            <p className="small dream-ask-chip">
              <span className="dream-ask-line">{`About: “${draft.quote}”`}</span>
              <button
                type="button"
                className="ibtn dream-ask-chip-x"
                aria-label="Remove the selected text from the ask"
                onClick={() => {
                  onDraft((d) => ({ ...d, quote: null }));
                  box.current?.focus({ preventScroll: true });
                }}
              >
                <Dismiss12Regular aria-hidden="true" />
              </button>
            </p>
          )}
          <div className="dream-ask-row">
            <textarea
              ref={box}
              className="input dream-ask-box"
              rows={2}
              aria-label="Ask for a change to this proposal"
              aria-describedby={off ? `${id}-off` : undefined}
              placeholder="Ask for a change to this proposal"
              maxLength={DREAM_ASK_MAX}
              disabled={off !== null}
              readOnly={busy === 'send'}
              value={draft.text}
              onChange={(e) => {
                const next = e.target.value;
                onDraft((d) => ({ ...d, text: next }));
              }}
              onKeyDown={onKeyDown}
              onMouseDown={takeQuote}
              onFocus={takeQuote}
            />
            <button
              type="button"
              className="btn"
              disabled={off !== null || !text || busy !== null}
              onClick={send}
            >
              Ask
            </button>
          </div>
          {off && (
            <p id={`${id}-off`} className="muted small">
              {off}
            </p>
          )}
          {failed && (
            <p className="text-warn small dream-ask-failed">
              <span>{`Could not make the change: ${failed.reason}`}</span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={off !== null}
                onClick={() => {
                  onDraft(() => ({
                    text: failed.ask,
                    quote: failed.quote ?? null,
                  }));
                  box.current?.focus({ preventScroll: true });
                }}
              >
                Try again
              </button>
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-red small">
          {error}
        </p>
      )}
      <p role="status" className="dream-ask-said">
        {said}
      </p>
    </div>
  );
}
