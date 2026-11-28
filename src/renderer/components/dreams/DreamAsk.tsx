import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import {
  DREAM_ASK_MAX,
  DREAM_QUOTE_MAX,
  redoAt,
  undoAt,
  type DreamAdjustment,
  type DreamProposal,
  type DreamResult,
} from '../../../shared/dreams';
import { dreamAskKey } from '../../../shared/askProgress';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { useStore } from '../../store';
import { MarkdownView } from '../docs/MarkdownView';
import {
  ASK_HINT,
  AskComposer,
  AskFailed,
  AskFoot,
  AskStepsFold,
  AskStopped,
  AskWorking,
  tookWords,
} from '../ask';

/** An ask as it is being written: the text and the lines it is about. */
export type AskDraft = { text: string; quote: string | null };
export const NO_DRAFT: AskDraft = { text: '', quote: null };

/** A note has no pictures of its own, and its links lead nowhere in the app. */
const NO_ASSET = () => Promise.reject(new Error('no pictures in a note'));
const NOTHING = () => undefined;

/** A note as it is said to a screen reader when the run ends: its start, not all 8 000 characters. */
const spoken = (note: string) =>
  note.length > 200 ? `${note.slice(0, 199)}…` : note;

/** How many asks show before "Earlier asks" opens the rest. */
const SHOWN = 3;
/** The reason an older Shellie stored for a stopped ask (`result.adjustFailed`). */
const OLD_STOPPED = 'It was stopped';

/** What came of an ask: `outcome`, or for a row of before it existed what `changed` says. */
const outcomeOf = (a: DreamAdjustment) =>
  a.outcome ?? (a.changed ? 'changed' : 'answer');

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
export function DreamAsk({
  result,
  proposal: p,
  draft,
  onDraft,
  scope,
  shownAsk,
  onShowAsk,
}: {
  result: DreamResult;
  proposal: DreamProposal;
  draft: AskDraft;
  onDraft: (update: (d: AskDraft) => AskDraft) => void;
  /** Where selected text counts as what an ask is about: the proposal's pane. */
  scope: RefObject<HTMLElement | null>;
  /** The ask (its `at`) whose own change the pane shows; null for the whole proposal. */
  shownAsk: string | null;
  onShowAsk: (at: string) => void;
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
  const go = useStore((s) => s.go);
  const progress = useStore((s) => s.askProgress[dreamAskKey(result.repoId)]);
  // A failure an older Shellie stored on the result shows as the proposal's last row.
  const old =
    result.adjustFailed?.proposalId === p.id ? result.adjustFailed : null;
  const asks: DreamAdjustment[] = [
    ...(p.adjustments ?? []),
    ...(old
      ? [
          {
            ask: old.ask,
            ...(old.quote === undefined ? {} : { quote: old.quote }),
            at: '',
            note: '',
            changed: false,
            reverted: [],
            outcome:
              old.reason === OLD_STOPPED
                ? ('stopped' as const)
                : ('failed' as const),
            reason: old.reason,
          },
        ]
      : []),
  ];
  const off = p.dropped
    ? 'Take the proposal back to change it'
    : run && !mine
      ? adjustingSentence(result)
      : null;
  const text = draft.text.trim();

  // The run started or ended: the focus follows what took the place of what held it, and the end is said.
  // An ask was sent again and the result has not said so yet: a second press starts nothing.
  const rerun = useRef(false);
  useEffect(() => {
    rerun.current = false;
  }, [run, asks.length]);
  // The newest ask is the one that matters: the list, which scrolls in its own room, shows its end.
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [asks.length, earlier]);
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
    const last = asks.at(-1);
    const end = last ? outcomeOf(last) : null;
    setSaid(
      !last
        ? ''
        : end === 'changed'
          ? `Changed: ${spoken(last.note)}`
          : end === 'answer'
            ? `Answer: ${spoken(last.note)}`
            : end === 'stopped'
              ? 'Stopped'
              : `Could not finish: ${last.reason ?? ''}`,
    );
    if (free) box.current?.focus({ preventScroll: true });
    // `asks` is rebuilt on every render: its length says whether it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, asks.length]);

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

  const adjust = (ask: string, quote: string | null | undefined) =>
    api().invoke(
      'dream:adjust',
      result.repoId,
      p.id,
      ask,
      ...(quote ? ([quote] as const) : []),
    );
  const send = () => {
    if (!text || off || mine || busy) return;
    setSaid('');
    void call('send', async () => {
      await adjust(text, draft.quote);
      onDraft(() => NO_DRAFT);
    });
  };
  /** Runs an ask that was stopped or could not finish once more, as it was; its row goes when the run starts. */
  const again = (a: DreamAdjustment) => {
    if (run || busy || p.dropped || rerun.current) return;
    rerun.current = true;
    setSaid('');
    void call('send', async () => {
      try {
        await adjust(a.ask, a.quote);
      } catch (e) {
        rerun.current = false;
        throw e;
      }
    });
  };
  const againOff = run !== null || busy !== null || p.dropped;

  const redo = () =>
    call('redo', async () => {
      await api().invoke('dream:adjustRedo', result.repoId, p.id);
      setSaid('The change was put back');
      box.current?.focus({ preventScroll: true });
    });
  const undo = () =>
    call('undo', async () => {
      await api().invoke('dream:adjustUndo', result.repoId, p.id);
      setSaid('The change was taken back');
      box.current?.focus({ preventScroll: true });
    });

  // The newest ask that changed the proposal is the one Undo takes back.
  // Undo takes back the newest change that stands; Redo puts back the oldest that was taken back.
  const undoIndex = undoAt(asks);
  const redoIndex = redoAt(asks);
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
        <ol
          ref={list}
          aria-label="Asks about this proposal"
          className="dream-asks"
        >
          {asks.slice(first).map((a, k) => {
            const i = first + k;
            const end = outcomeOf(a);
            return (
              <li
                key={`${a.at}-${i}`}
                className={a.undone ? 'dream-asked is-undone' : 'dream-asked'}
              >
                <p id={`${id}-ask-${i}`}>
                  <span className="muted">You: </span>
                  {a.ask}
                </p>
                {a.quote && (
                  <p className="muted small ask-chip-text">{`About: “${a.quote}”`}</p>
                )}
                {end === 'stopped' ? (
                  <AskStopped
                    afterMs={a.durationMs ?? null}
                    onAgain={() => again(a)}
                    againOff={againOff}
                  />
                ) : end === 'failed' ? (
                  <AskFailed
                    reason={a.reason ?? ''}
                    onRetry={() => again(a)}
                    retryOff={againOff}
                    second={
                      a.fix === 'settings'
                        ? {
                            label: "Open the dream's settings",
                            run: () => go({ kind: 'dream-setup' }),
                          }
                        : undefined
                    }
                  />
                ) : (
                  <>
                    <p className="muted small dream-asked-label">
                      {a.undone
                        ? 'Taken back'
                        : end === 'changed'
                          ? 'Changed'
                          : 'Answer'}
                    </p>
                    <div className="dream-asked-note">
                      <MarkdownView
                        asset={NO_ASSET}
                        path="note.md"
                        text={a.note}
                        onOpenDoc={NOTHING}
                        onOpenFile={NOTHING}
                        idPrefix={`${id}-note-${i}-`}
                      />
                    </div>
                    {end === 'changed' && (
                      <div
                        role="group"
                        aria-label="What this ask changed"
                        className="ask-strip dream-asked-strip"
                      >
                        {(a.stat?.length ?? 0) > 0 && (
                          <ul className="dream-asked-stat">
                            {a.stat?.map((f) => (
                              <li key={f.path}>
                                <span className="mono small">{f.path}</span>
                                <span className="mono small dream-stat-add">{`+${f.added}`}</span>
                                <span className="mono small dream-stat-del">{`−${f.removed}`}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <span className="dream-asked-strip-end">
                          {a.after && !a.undone && (
                            <button
                              type="button"
                              className="link small"
                              aria-pressed={shownAsk === a.at}
                              onClick={() => onShowAsk(a.at)}
                            >
                              Show what this changed
                            </button>
                          )}
                          {i === undoIndex && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              aria-describedby={`${id}-ask-${i}`}
                              disabled={
                                run !== null || busy !== null || p.dropped
                              }
                              onClick={() => void undo()}
                            >
                              Undo
                            </button>
                          )}
                          {i === redoIndex && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              aria-describedby={`${id}-ask-${i}`}
                              disabled={
                                run !== null || busy !== null || p.dropped
                              }
                              onClick={() => void redo()}
                            >
                              Redo
                            </button>
                          )}
                        </span>
                      </div>
                    )}
                    {a.reverted.length > 0 && (
                      <p className="text-warn small">
                        {`Left as they were: ${a.reverted.join(', ')}`}
                      </p>
                    )}
                    <AskFoot
                      parts={[
                        a.durationMs !== undefined &&
                          `Took ${tookWords(a.durationMs)}`,
                      ]}
                    />
                    <AskStepsFold steps={a.steps} />
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {mine && run && (
        <div className="dream-asked">
          <p className="dream-ask-running">
            <span className="muted">You: </span>
            {run.ask}
          </p>
          {run.quote && (
            <p className="muted small ask-chip-text">{`About: “${run.quote}”`}</p>
          )}
          <AskWorking
            word="Working"
            startedAt={run.startedAt}
            progress={progress}
            focusRef={working}
            stopOff={busy !== null}
            onStop={() =>
              void call('stop', () =>
                api().invoke('dream:adjustStop', result.repoId),
              )
            }
          />
        </div>
      )}
      <AskComposer
        label="Ask for a change to this proposal"
        value={draft.text}
        onChange={(next) => onDraft((d) => ({ ...d, text: next }))}
        onSend={send}
        hint={
          asks.length === 0
            ? `${ASK_HINT} · select text above to ask about it`
            : null
        }
        quote={draft.quote}
        onQuoteRemove={() => {
          onDraft((d) => ({ ...d, quote: null }));
          box.current?.focus({ preventScroll: true });
        }}
        off={off}
        waiting={mine ? 'Wait for this one, or stop it' : null}
        sending={busy === 'send'}
        maxLength={DREAM_ASK_MAX}
        boxRef={box}
        boxProps={{ onMouseDown: takeQuote, onFocus: takeQuote }}
      />
      {error && (
        <p role="alert" className="text-red small">
          {error}
        </p>
      )}
      <p
        role="status"
        aria-label="What the ask came to"
        className="dream-ask-said"
      >
        {said}
      </p>
    </div>
  );
}
