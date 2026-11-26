import { type FormEvent, useEffect, useState } from 'react';
import type {
  BrainPageRow,
  BrainSourceRow,
  BrainView,
} from '../../../shared/brain';
import { citedPaths, linkCited } from '../../../shared/brainAsk';
import { errorMessage } from '../../../shared/errors';
import type { SendAnswerResult } from '../../../shared/ipc';
import { eur } from '../../../shared/text';
import type { TerminalDef } from '../../../shared/types';
import { api } from '../../api';
import { type AskExchange, useStore } from '../../store';
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

/** The seconds since `startedAt`, counted while mounted. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{Math.max(0, Math.round((now - startedAt) / 1000))} s</>;
}

/**
 * What a task asked its brain, in the Brain tab: each question with its answer (the pages it names as links and as
 * cards), oldest first, then a follow-up. The thread lives in the store, so an answer lands while another tab shows.
 */
export function BrainAnswers({
  brain,
  taskId,
  rows,
  sources,
  hasAgentTab,
  onOpen,
  onTerminal,
}: {
  brain: BrainView;
  taskId: string;
  rows: BrainPageRow[];
  sources: BrainSourceRow[];
  /** The task has a Claude Code or OpenCode tab an answer can be handed to. */
  hasAgentTab: boolean;
  /** Opens a page or a source in place. */
  onOpen: (path: string, anchor?: string) => void;
  onTerminal: (def: TerminalDef) => void;
}) {
  const thread = useStore((s) => s.brainAsksByTask[taskId]) ?? NO_THREAD;
  const askBrain = useStore((s) => s.askBrain);
  const stopBrainAsk = useStore((s) => s.stopBrainAsk);
  const setBrainAskOpen = useStore((s) => s.setBrainAskOpen);
  const setTab = useStore((s) => s.setTab);
  const notify = useStore((s) => s.notify);
  const { asset, openFile, lightbox } = usePageMedia(brain.id);
  const [followUp, setFollowUp] = useState('');
  /** Why the agent could not take an answer, per exchange. */
  const [sendNote, setSendNote] = useState<Record<string, string>>({});
  const running = thread.some((e) => e.status === 'running');

  const pageOf = (p: string) => rows.find((r) => r.path === p);
  const sourceOf = (p: string) => sources.find((s) => s.path === p);
  const exists = (p: string) => !!pageOf(p) || !!sourceOf(p);

  const terminal = async (sessionId?: string | null) => {
    const def = await openBrainTerminal(brain.id, notify, sessionId);
    if (def) onTerminal(def);
  };
  const send = async (e: AskExchange) => {
    if (!e.answer) return;
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
    void navigator.clipboard
      .writeText(e.answer?.answer ?? '')
      .catch((err: unknown) => notify('error', errorMessage(err)));
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!followUp.trim()) return;
    void askBrain(taskId, brain.id, followUp, 'follow-up');
    setFollowUp('');
  };

  return (
    <div className="brain-qas">
      <div className="brain-qas-bar">
        <button
          type="button"
          className="link small"
          onClick={() => setBrainAskOpen(taskId, false)}
        >
          Back to the brain's start
        </button>
      </div>
      {thread.map((e) => {
        const cited = e.answer
          ? citedPaths(e.answer.answer).filter(exists)
          : [];
        return (
          <section key={e.id} className="brain-qa">
            <p className="brain-qa-asked muted small">You asked</p>
            <h2 className="brain-qa-question">{e.question}</h2>
            {e.status === 'running' && (
              <p className="brain-qa-running" role="status">
                <span>
                  Reading the brain… <Elapsed startedAt={e.startedAt} />
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => stopBrainAsk(taskId)}
                >
                  Stop
                </button>
              </p>
            )}
            {e.status === 'failed' && (
              <div className="brain-qa-failed">
                <p role="alert">{e.error}</p>
                <div className="brain-qa-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={running}
                    onClick={() =>
                      void askBrain(taskId, brain.id, e.question, 'typed')
                    }
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void terminal()}
                  >
                    Open the brain's terminal
                  </button>
                </div>
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
                    {hasAgentTab && (
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
                      Copy
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
                  <p className="brain-qa-foot muted small">
                    {[
                      `Took ${Math.round(e.answer.durationMs / 1000)} s`,
                      ...(e.answer.costEur === null
                        ? []
                        : [`${eur(e.answer.costEur)} on the brain`]),
                      e.answer.changed
                        ? "The brain's folder changed while this was answered (a job or someone at work, most likely). Check the brain's Health."
                        : 'nothing was changed in the brain',
                    ].join(' · ')}
                  </p>
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
      {!running && thread.length > 0 && (
        <form className="brain-qa-follow" onSubmit={submit}>
          <input
            className="field"
            aria-label="Follow-up question"
            placeholder="Ask a follow-up"
            value={followUp}
            onChange={(ev) => setFollowUp(ev.target.value)}
          />
          <button
            type="submit"
            className="btn btn-sm"
            disabled={!followUp.trim()}
          >
            Ask
          </button>
        </form>
      )}
      {lightbox}
    </div>
  );
}
