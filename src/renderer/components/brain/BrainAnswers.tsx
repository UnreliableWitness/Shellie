import { useEffect, useRef, useState } from 'react';
import type {
  BrainPageRow,
  BrainSourceRow,
  BrainView,
} from '../../../shared/brain';
import { brainAskKey } from '../../../shared/askProgress';
import {
  askOwner,
  citedPaths,
  linkCited,
  type AskThread,
} from '../../../shared/brainAsk';
import { errorMessage } from '../../../shared/errors';
import type { SendAnswerResult } from '../../../shared/ipc';
import { eur } from '../../../shared/text';
import type { TerminalDef } from '../../../shared/types';
import { api } from '../../api';
import { type AskExchange, useStore } from '../../store';
import {
  AskComposer,
  AskFailed,
  AskFoot,
  AskStepsFold,
  AskStopped,
  AskWorking,
  tookWords,
} from '../ask';
import { MarkdownView } from '../docs/MarkdownView';
import { openBrainTerminal, trackBrain } from './brainActions';
import { PageTags } from './PageCards';
import { sourceLabel } from './recent';
import { usePageMedia } from './usePageMedia';

const NO_THREAD: AskExchange[] = [];
const SEND_REFUSED: Record<
  Extract<SendAnswerResult, { ok: false }>['reason'],
  string
> = {
  busy: 'The agent is busy. Try again when it is done.',
  typing: "The agent's tab has unsent text. Send or clear it first.",
  none: 'No agent tab can take it right now.',
};

/** How long Copy says "Copied". */
const COPIED_MS = 2000;

/**
 * What a task asked its brain, in the Brain tab: each question with its answer (the pages it names as links and as
 * cards), oldest first, then a follow-up. The thread lives in the store, so an answer lands while another tab shows.
 */
/** The day a thread began, as "20 Nov". */
const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** The earlier threads of an asker, newest first. */
export const earlierOf = (earlier: AskThread[], owner: string): AskThread[] =>
  earlier
    .filter((t) => askOwner(t.taskId, t.brainId) === owner)
    .sort((a, b) => b.startedAt - a.startedAt);

/** "Earlier questions (n)": the asker's earlier threads by their first question; one click gets a thread back. */
export function EarlierQuestions({ owner }: { owner: string }) {
  const all = useStore((s) => s.brainAskEarlier);
  const openBrainThread = useStore((s) => s.openBrainThread);
  const running = useStore(
    (s) =>
      s.brainAsksByTask[owner]?.some((e) => e.status === 'running') ?? false,
  );
  const [open, setOpen] = useState(false);
  const threads = earlierOf(all, owner);
  if (threads.length === 0) return null;
  return (
    <div className="brain-qa-earlier">
      <button
        type="button"
        className="link small"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {`Earlier questions (${threads.length})`}
      </button>
      {open && (
        <ul aria-label="Earlier questions">
          {threads.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className="brain-qa-earlier-row"
                disabled={running}
                onClick={() => {
                  trackBrain('ask-earlier');
                  openBrainThread(owner, t.id);
                  setOpen(false);
                }}
              >
                <span>{t.exchanges[0]?.question}</span>
                <span className="muted small">{shortDate(t.startedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BrainAnswers({
  brain,
  owner,
  taskId,
  exchanges,
  back = true,
  rows,
  sources,
  hasAgentTab,
  onOpen,
  onTerminal,
}: {
  brain: BrainView;
  /** The asker (`askOwner`) whose current thread shows. */
  owner: string;
  /** The task an answer can be handed to; null on the brain's own page. */
  taskId: string | null;
  /** A thread to read only (another asker's, on the Brain page): shown in place of the asker's own, with nothing to ask. */
  exchanges?: AskExchange[];
  /** Whether there is a start to go back to (the task's tab has one). */
  back?: boolean;
  rows: BrainPageRow[];
  sources: BrainSourceRow[];
  /** The task has a Claude Code or OpenCode tab an answer can be handed to. */
  hasAgentTab: boolean;
  /** Opens a page or a source in place. */
  onOpen: (path: string, anchor?: string) => void;
  onTerminal: (def: TerminalDef) => void;
}) {
  const own = useStore((s) => s.brainAsksByTask[owner]) ?? NO_THREAD;
  const readOnly = exchanges !== undefined;
  const thread = exchanges ?? own;
  const newBrainQuestion = useStore((s) => s.newBrainQuestion);
  const askBrain = useStore((s) => s.askBrain);
  const stopBrainAsk = useStore((s) => s.stopBrainAsk);
  const setBrainAskOpen = useStore((s) => s.setBrainAskOpen);
  const setTab = useStore((s) => s.setTab);
  const go = useStore((s) => s.go);
  const progress = useStore((s) => s.askProgress[brainAskKey(owner)]);
  const notify = useStore((s) => s.notify);
  const { asset, openFile, lightbox } = usePageMedia(brain.id);
  const [followUp, setFollowUp] = useState('');
  /** Why the agent could not take an answer, per exchange. */
  const [sendNote, setSendNote] = useState<Record<string, string>>({});
  const running = thread.some((e) => e.status === 'running');
  /** The exchange whose answer was just copied. */
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const pageOf = (p: string) => rows.find((r) => r.path === p);
  const sourceOf = (p: string) => sources.find((s) => s.path === p);
  const exists = (p: string) => !!pageOf(p) || !!sourceOf(p);

  const terminal = async (sessionId?: string | null) => {
    const def = await openBrainTerminal(brain.id, notify, sessionId);
    if (def) onTerminal(def);
  };
  const send = async (e: AskExchange) => {
    if (!e.answer || taskId === null) return;
    try {
      const r = await api().invoke(
        'brain:sendAnswer',
        taskId,
        e.question,
        e.answer.answer,
      );
      trackBrain(
        'ask-send',
        r.ok ? { ok: 'true' } : { ok: 'false', reason: r.reason },
      );
      if (r.ok) setTab(taskId, r.terminalId);
      else setSendNote((n) => ({ ...n, [e.id]: SEND_REFUSED[r.reason] }));
    } catch (err) {
      notify('error', errorMessage(err));
    }
  };
  const copy = (e: AskExchange) => {
    trackBrain('ask-copy');
    void navigator.clipboard.writeText(e.answer?.answer ?? '').then(
      () => {
        setCopied(e.id);
        clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS);
      },
      (err: unknown) => notify('error', errorMessage(err)),
    );
  };
  const submit = () => {
    if (!followUp.trim() || running) return;
    void askBrain(owner, brain.id, followUp, 'follow-up');
    setFollowUp('');
  };
  /** Asks the question of a stopped or failed exchange once more, in its place. */
  const again = (e: AskExchange) =>
    void askBrain(owner, brain.id, e.question, 'typed', e.id);

  return (
    <div className="brain-qas">
      {!readOnly && (
        <div className="brain-qas-bar">
          {back && (
            <button
              type="button"
              className="link small"
              onClick={() => setBrainAskOpen(owner, false)}
            >
              Back to the brain's start
            </button>
          )}
          <span className="brain-qas-bar-end">
            <EarlierQuestions owner={owner} />
            <button
              type="button"
              className="btn btn-sm"
              disabled={running || thread.length === 0}
              onClick={() => {
                trackBrain('ask-new');
                newBrainQuestion(owner);
                setBrainAskOpen(owner, false);
              }}
            >
              New question
            </button>
          </span>
        </div>
      )}
      {thread.map((e) => {
        const cited = e.answer
          ? citedPaths(e.answer.answer).filter(exists)
          : [];
        return (
          <section key={e.id} className="brain-qa">
            <p className="brain-qa-asked muted small">You asked</p>
            <h2 className="brain-qa-question">{e.question}</h2>
            {e.status === 'running' && (
              <div className="brain-qa-state">
                <AskWorking
                  word="Answering"
                  startedAt={e.startedAt}
                  onStop={() => stopBrainAsk(owner)}
                  progress={progress}
                >
                  {progress?.text && (
                    <div className="brain-doc brain-qa-text brain-qa-coming">
                      <MarkdownView
                        asset={asset}
                        path="index.md"
                        text={progress.text}
                        onOpenDoc={onOpen}
                        onOpenFile={openFile}
                        idPrefix={`${e.id}-coming-`}
                      />
                    </div>
                  )}
                </AskWorking>
              </div>
            )}
            {e.status === 'stopped' && readOnly && (
              <p className="muted small">Stopped.</p>
            )}
            {e.status === 'failed' && readOnly && (
              <p className="muted small">{`Could not finish. ${e.error ?? ''}`}</p>
            )}
            {e.status === 'stopped' && !readOnly && (
              <div className="brain-qa-state">
                <AskStopped
                  afterMs={e.endedAt ? e.endedAt - e.startedAt : null}
                  onAgain={() => again(e)}
                  againOff={running}
                />
              </div>
            )}
            {e.status === 'failed' && !readOnly && (
              <div className="brain-qa-state">
                <AskFailed
                  reason={e.error ?? ''}
                  onRetry={() => again(e)}
                  retryOff={running}
                  second={
                    e.refused === 'held'
                      ? {
                          label: 'Open settings',
                          run: () =>
                            go({
                              kind: 'settings',
                              scope: 'project',
                              connectionId: brain.connectionId,
                              section: 'project-brains',
                            }),
                        }
                      : {
                          label: "Open the brain's terminal",
                          run: () => void terminal(),
                        }
                  }
                />
              </div>
            )}
            {e.status === 'done' && e.answer && (
              <div className="brain-qa-cols">
                <div className="brain-qa-main">
                  <div className="brain-doc brain-qa-text">
                    <MarkdownView
                      asset={asset}
                      path="index.md"
                      text={linkCited(e.answer.answer, exists)}
                      onOpenDoc={onOpen}
                      onOpenFile={openFile}
                      idPrefix={`${e.id}-`}
                    />
                  </div>
                  <div className="brain-qa-actions">
                    {hasAgentTab && !readOnly && taskId !== null && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void send(e)}
                      >
                        Send to this task's agent
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => copy(e)}
                    >
                      {copied === e.id ? 'Copied' : 'Copy'}
                    </button>
                    {e.answer.sessionId && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void terminal(e.answer?.sessionId)}
                      >
                        Continue in the terminal
                      </button>
                    )}
                  </div>
                  {sendNote[e.id] && (
                    <p className="small" role="status">
                      {sendNote[e.id]}
                    </p>
                  )}
                  <AskFoot
                    parts={[
                      `Took ${tookWords(e.answer.durationMs)}`,
                      e.answer.pagesRead !== undefined &&
                        `read ${e.answer.pagesRead} ${e.answer.pagesRead === 1 ? 'page' : 'pages'}`,
                      e.answer.costEur !== null &&
                        `${eur(e.answer.costEur)} on the brain`,
                      !!e.answer.restarted &&
                        "a new conversation: the brain's agent changed",
                      e.answer.changed
                        ? "The brain's folder changed while this was answered (a job or someone at work, most likely). Check the brain's Health."
                        : 'nothing was changed in the brain',
                    ]}
                  />
                  <AskStepsFold steps={e.answer.steps} />
                </div>
                {cited.length > 0 && (
                  <aside className="brain-qa-sources">
                    <h3 id={`${e.id}-from`}>Where this comes from</h3>
                    <ul aria-labelledby={`${e.id}-from`}>
                      {cited.map((p) => {
                        const row = pageOf(p);
                        const src = sourceOf(p);
                        return (
                          <li key={p}>
                            <button
                              type="button"
                              className="brain-card brain-qa-source"
                              title={p}
                              onClick={() => onOpen(p, undefined)}
                            >
                              <span className="brain-card-title">
                                {row ? row.title : sourceLabel(p)}
                              </span>
                              {row ? (
                                <PageTags row={row} />
                              ) : (
                                <span className="muted small">
                                  {src?.contents ?? `Source · ${src?.type}`}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </aside>
                )}
              </div>
            )}
          </section>
        );
      })}
      {thread.length > 0 && !readOnly && (
        <div className="brain-qa-follow">
          <AskComposer
            label="Ask a follow-up"
            value={followUp}
            onChange={setFollowUp}
            onSend={submit}
            waiting={running ? 'Wait for this answer, or stop it' : null}
          />
        </div>
      )}
      {lightbox}
    </div>
  );
}
