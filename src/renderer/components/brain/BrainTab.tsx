import { useCallback, useEffect, useRef, useState } from 'react';
import { picturesReady, type BrainView } from '../../../shared/brain';
import { ASK_SUGGESTIONS } from '../../../shared/brainAsk';
import type { TerminalDef } from '../../../shared/types';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { openPiece } from '../../hooks/useReadingFeed';
import { type AskVia, useStore } from '../../store';
import { track } from '../../telemetry';
import { useReadsForTask } from '../reading/BeforeYouStart';
import { ASK_HINT, AskComposer } from '../ask';
import { BrainAnswers } from './BrainAnswers';
import { openBrainTerminal, trackBrain } from './brainActions';
import { BrainPage } from './BrainPage';
import { BrainSearch } from './BrainSearch';
import { useBrainPages } from './BrainWiki';
import { PageCard, PageSections } from './PageCards';
import { AddedNotes, PendingFiles } from './PendingFiles';
import { useBrainDrop } from './useBrainDrop';
import { useBrainNav } from './useBrainNav';

/**
 * A task's Brain tab, as a guide: what the brain is, then three steps. Ask (the answers show in place, BrainAnswers),
 * read what applies to this task (its long reads and the pages that mention it; every page behind a disclosure),
 * and add what you learn (the whole tab takes dropped files as new sources). A page opens in place. Opening the tab
 * starts no agent.
 */
export function BrainTab({
  brain,
  taskId,
  hasAgentTab,
  onTerminal,
}: {
  brain: BrainView;
  taskId: string;
  /** The task has a Claude Code or OpenCode tab an answer can be handed to. */
  hasAgentTab: boolean;
  onTerminal: (def: TerminalDef) => void;
}) {
  const go = useStore((s) => s.go);
  const notify = useStore((s) => s.notify);
  const about = useStore((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    return t?.workItem?.title || t?.name || 'this task';
  });
  const askBrain = useStore((s) => s.askBrain);
  const asked = useStore((s) => s.brainAsksByTask[taskId]?.length ?? 0);
  const asking = useStore(
    (s) =>
      s.brainAsksByTask[taskId]?.some((e) => e.status === 'running') ?? false,
  );
  const answersOpen = useStore((s) => !!s.brainAskOpenByTask[taskId]);
  const setBrainAskOpen = useStore((s) => s.setBrainAskOpen);
  const drop = useBrainDrop(brain.id);
  const { over, problems, added, dropProps, addFiles } = drop;
  const { rows, sources, loaded } = useBrainPages(brain.id);
  const nav = useBrainNav();
  const reads = useReadsForTask(taskId);
  const [searching, setSearching] = useState(false);
  const [question, setQuestion] = useState('');
  // The full list is only rendered once asked for: it can be hundreds of rows.
  const [allOpen, setAllOpen] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [relevant, setRelevant] = useState<string[]>([]);
  const loadRelevant = useCallback(() => {
    api()
      .invoke('brain:relevant', brain.id, taskId)
      .then(setRelevant, () => setRelevant([]));
  }, [brain.id, taskId]);
  useEffect(loadRelevant, [loadRelevant]);
  useBrainChanged(brain.id, loadRelevant);
  const open = useCallback(
    (path: string, anchor?: string) => nav.open(path, anchor),
    [nav],
  );
  const relevantRows = relevant
    .map((p) => rows.find((r) => r.path === p))
    .filter((r): r is NonNullable<typeof r> => !!r);
  const hasReads = reads.length > 0;
  useEffect(() => {
    if (hasReads) track('reading.nudge', { kind: 'task' });
  }, [hasReads, taskId]);

  const ask = (text: string, via: AskVia) =>
    void askBrain(taskId, brain.id, text, via);
  const submit = () => {
    // While an answer is coming nothing is asked, so what is typed stays.
    if (!question.trim() || asking) return;
    ask(question, 'typed');
    setQuestion('');
  };
  const terminal = async () => {
    const def = await openBrainTerminal(brain.id, notify);
    if (!def) return;
    trackBrain('terminal-from-tab');
    onTerminal(def);
  };
  const agent =
    brain.options.agent === 'opencode'
      ? `OpenCode${brain.options.opencodeModel ? `, ${brain.options.opencodeModel}` : ''}`
      : `Claude Code, ${brain.options.model}`;
  const empty = loaded && rows.length === 0;
  const showAnswers = answersOpen && asked > 0;

  return (
    <div
      className={over ? 'brain-tab is-over' : 'brain-tab'}
      data-dropzone
      aria-label={`${brain.name} brain, drop files to add them`}
      {...dropProps}
    >
      <div className={nav.current ? 'brain-tab-col is-page' : 'brain-tab-col'}>
        <PendingFiles drop={drop} />
        {problems.length > 0 && (
          <ul className="brain-problems small" role="alert">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
        <AddedNotes brainId={brain.id} added={added} jobs={brain.jobs} />
        {nav.current && (
          <BrainPage
            brainId={brain.id}
            path={nav.current.path}
            anchor={nav.current.anchor}
            rows={rows}
            sources={sources}
            canBack={nav.canBack}
            canForward={nav.canForward}
            onOpen={open}
            onBack={nav.back}
            onForward={nav.forward}
            jobs={brain.jobs}
            skillsReady={picturesReady(brain)}
          />
        )}
        {!nav.current && showAnswers && (
          <BrainAnswers
            brain={brain}
            taskId={taskId}
            rows={rows}
            sources={sources}
            hasAgentTab={hasAgentTab}
            onOpen={open}
            onTerminal={onTerminal}
          />
        )}
        {/* The start stays mounted under an open page, so a search and its results are there on Back. */}
        <div hidden={!!nav.current || showAnswers} className="brain-guide">
          <header className="brain-guide-head">
            <p className="brain-guide-name">
              <span className="brain-step-label">{brain.name} brain</span>
              <button
                type="button"
                className="link small"
                onClick={() => go({ kind: 'brain', brainId: brain.id })}
              >
                Open the whole brain
              </button>
            </p>
            <h2>What the project already knows about this task</h2>
            <p className="muted brain-guide-lead">
              The brain keeps the project's decisions, documents and meeting
              notes as pages. Ask it, read what applies to{' '}
              <span className="brain-guide-about">{about}</span>, and add what
              you learn.
            </p>
          </header>

          <section className="brain-step" aria-labelledby="brain-step-ask">
            <div className="brain-step-head">
              <h3 id="brain-step-ask">1 · Ask</h3>
              {asked > 0 && (
                <button
                  type="button"
                  className="link small"
                  onClick={() => setBrainAskOpen(taskId, true)}
                >
                  Show the answers ({asked})
                </button>
              )}
            </div>
            <AskComposer
              label="Question for the brain"
              placeholder="Ask anything about this task or the project"
              value={question}
              onChange={setQuestion}
              onSend={submit}
              hint={ASK_HINT}
              waiting={asking ? 'Wait for the answer, or stop it' : null}
              primary
            />
            <div className="brain-guide-try">
              <span className="muted small">Try</span>
              {ASK_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="brain-guide-chip"
                  disabled={asking}
                  onClick={() => ask(s, 'suggested')}
                >
                  {s}
                </button>
              ))}
            </div>
            <p className="muted small brain-guide-note">
              Answers name the pages they come from. Asking runs the brain's
              agent ({agent}) and is counted on the brain, not on this task.
            </p>
          </section>

          <section className="brain-step" aria-labelledby="brain-step-read">
            <div className="brain-step-head">
              <h3 id="brain-step-read">2 · Read what applies</h3>
              <span className="muted small">
                Picked from the work item's words. No AI used.
              </span>
            </div>
            {!searching &&
              (hasReads || relevantRows.length > 0 ? (
                <div className="brain-card-grid">
                  {reads.map(({ brain: b, read }) => (
                    <button
                      key={`${b.brainId}:${read.path}`}
                      type="button"
                      className="brain-card"
                      title={read.path}
                      onClick={() =>
                        openPiece(b.brainId, read.path, 'task', 'work', 'read')
                      }
                    >
                      <span className="muted small">
                        Long read · {read.minutes} min
                      </span>
                      <span className="brain-card-title">{read.title}</span>
                    </button>
                  ))}
                  {relevantRows.map((r) => (
                    <PageCard key={r.path} row={r} onOpen={open} />
                  ))}
                </div>
              ) : (
                <p className="muted small">
                  {empty
                    ? 'This brain has no pages yet. Add a first document below.'
                    : 'No page mentions this task yet. Ask, or search.'}
                </p>
              ))}
            {!empty && (
              <BrainSearch
                brainId={brain.id}
                onOpen={open}
                onActive={setSearching}
              />
            )}
            {!searching && rows.length > 0 && (
              <details
                className="brain-guide-all"
                onToggle={(e) => setAllOpen(e.currentTarget.open)}
              >
                <summary>All pages ({rows.length})</summary>
                {allOpen && <PageSections rows={rows} compact onOpen={open} />}
              </details>
            )}
          </section>

          <section className="brain-step" aria-labelledby="brain-step-add">
            <div className="brain-step-head">
              <h3 id="brain-step-add">3 · Add what you learn</h3>
            </div>
            <div className="brain-guide-add">
              <div className="brain-guide-add-text">
                <strong>
                  Drop a file anywhere on this tab, or write a note
                </strong>
                <span className="muted small">
                  A specification, an e-mail, a meeting transcript. The brain
                  turns it into pages the next task can use. When you finish
                  this task, Shellie also offers to save its lessons.
                </span>
              </div>
              <div className="brain-guide-add-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    go({ kind: 'brain', brainId: brain.id, focus: 'drop' })
                  }
                >
                  Write a note
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => picker.current?.click()}
                >
                  Choose files
                </button>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  aria-label="Choose files to add"
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []));
                    e.target.value = '';
                  }}
                />
              </div>
            </div>
          </section>

          <p className="brain-guide-foot muted small">
            Prefer to work with the brain's agent yourself?{' '}
            <button
              type="button"
              className="link small"
              onClick={() => void terminal()}
            >
              Open the brain's terminal
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
