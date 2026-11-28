import { useEffect, useRef, useState } from 'react';
import type {
  BrainPageRow,
  BrainSourceRow,
  BrainView,
} from '../../../shared/brain';
import { askOwner, type AskThread } from '../../../shared/brainAsk';
import type { TerminalDef } from '../../../shared/types';
import { askThreadsToSave, useStore } from '../../store';
import { ASK_HINT, AskComposer } from '../ask';
import { trackBrain } from './brainActions';
import { BrainAnswers } from './BrainAnswers';

const firstQuestion = (t: AskThread) => t.exchanges[0]?.question ?? '';
const day = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * The Brain page's Ask view: what was asked of this brain on the left (from its own page, and in tasks), the
 * thread on the right with its answers in place. A task's thread is only read here; it is asked in from the task.
 */
export function BrainAsk({
  brain,
  rows,
  sources,
  active,
  focusBox,
  onOpen,
  onTerminal,
}: {
  brain: BrainView;
  rows: BrainPageRow[];
  sources: BrainSourceRow[];
  /** The view is the one showing. */
  active: boolean;
  /** Put the cursor in the question box when the view shows (the route asked for Ask). */
  focusBox: boolean;
  onOpen: (path: string, anchor?: string) => void;
  onTerminal: (def: TerminalDef) => void;
}) {
  const owner = askOwner(null, brain.id);
  const own = useStore((s) => s.brainAsksByTask[owner]);
  const ownMeta = useStore((s) => s.brainAskThread[owner]);
  const asksByOwner = useStore((s) => s.brainAsksByTask);
  const metaByOwner = useStore((s) => s.brainAskThread);
  const earlier = useStore((s) => s.brainAskEarlier);
  const tasks = useStore((s) => s.tasks);
  const askBrain = useStore((s) => s.askBrain);
  const newBrainQuestion = useStore((s) => s.newBrainQuestion);
  const openBrainThread = useStore((s) => s.openBrainThread);
  const openTask = useStore((s) => s.openTask);
  const [question, setQuestion] = useState('');
  /** A task's thread chosen to read; null shows the brain's own. */
  const [reading, setReading] = useState<string | null>(null);
  // The box that shows: the first question's, or the open thread's follow-up.
  const box = useRef<HTMLTextAreaElement>(null);
  /** Counts up when the cursor is wanted in the box once it is there (after New question). */
  const [wanted, setWanted] = useState(0);
  useEffect(() => {
    if (active && (focusBox || wanted > 0)) box.current?.focus();
  }, [active, focusBox, wanted]);

  const all = askThreadsToSave({
    brainAsksByTask: asksByOwner,
    brainAskThread: metaByOwner,
    brainAskEarlier: earlier,
  }).filter((t) => t.brainId === brain.id);
  const newest = (a: AskThread, b: AskThread) => b.startedAt - a.startedAt;
  const mine = all.filter((t) => t.taskId === null).sort(newest);
  const inTasks = all.filter((t) => t.taskId !== null).sort(newest);
  const read = inTasks.find((t) => t.id === reading) ?? null;
  const asking = own?.some((e) => e.status === 'running') ?? false;
  const hasOwn = (own?.length ?? 0) > 0;
  const taskOf = (t: AskThread) => tasks.find((x) => x.id === t.taskId);

  const ask = () => {
    if (!question.trim() || asking) return;
    void askBrain(owner, brain.id, question, 'typed');
    setQuestion('');
  };
  const pick = (t: AskThread) => {
    if (t.taskId !== null) return setReading(t.id);
    setReading(null);
    if (t.id !== ownMeta?.id) openBrainThread(owner, t.id);
  };

  return (
    <div className="brain-ask-view">
      <nav aria-label="Questions" className="brain-ask-list">
        <div className="brain-ask-list-head">
          <span className="muted small">Questions</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={asking || (!hasOwn && read === null)}
            onClick={() => {
              trackBrain('ask-new');
              setReading(null);
              newBrainQuestion(owner);
              setWanted((n) => n + 1);
            }}
          >
            New question
          </button>
        </div>
        {mine.length === 0 && (
          <p className="muted small brain-ask-list-none">
            Nothing asked here yet.
          </p>
        )}
        <ul>
          {mine.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className="brain-ask-row"
                aria-current={
                  read === null && t.id === ownMeta?.id ? 'true' : undefined
                }
                disabled={asking && t.id !== ownMeta?.id}
                onClick={() => pick(t)}
              >
                <span>{firstQuestion(t)}</span>
                <span className="muted small">{day(t.startedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
        {inTasks.length > 0 && (
          <>
            <p className="muted small brain-ask-list-sub">Asked in tasks</p>
            <ul>
              {inTasks.map((t) => {
                const task = taskOf(t);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="brain-ask-row"
                      aria-current={read?.id === t.id ? 'true' : undefined}
                      onClick={() => pick(t)}
                    >
                      <span>{firstQuestion(t)}</span>
                      <span className="muted small mono">
                        {task ? (task.workItem?.id ?? task.name) : 'gone'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className="muted small brain-ask-list-foot">
          Questions are kept on this computer. They are not part of the brain
          and are not shared.
        </p>
      </nav>
      <div className="brain-ask-thread">
        {read ? (
          <>
            <div className="brain-ask-read-bar">
              <span className="muted small">
                Asked in a task. Ask a follow-up from the task.
              </span>
              {taskOf(read) && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => openTask(read.taskId ?? '')}
                >
                  Open the task
                </button>
              )}
            </div>
            <BrainAnswers
              brain={brain}
              owner={owner}
              taskId={null}
              exchanges={read.exchanges}
              rows={rows}
              sources={sources}
              hasAgentTab={false}
              onOpen={onOpen}
              onTerminal={onTerminal}
            />
          </>
        ) : hasOwn ? (
          <BrainAnswers
            brain={brain}
            owner={owner}
            taskId={null}
            back={false}
            bar={false}
            boxRef={box}
            rows={rows}
            sources={sources}
            hasAgentTab={false}
            onOpen={onOpen}
            onTerminal={onTerminal}
          />
        ) : (
          <div className="brain-ask-empty">
            <h2>Ask {brain.name}</h2>
            <p className="muted">
              The brain answers from its pages and names the ones it used.
              Asking runs the brain's agent and is counted on the brain.
            </p>
            <AskComposer
              label="Question for the brain"
              placeholder="Ask anything about the project"
              value={question}
              onChange={setQuestion}
              onSend={ask}
              hint={ASK_HINT}
              primary
              boxRef={box}
            />
          </div>
        )}
      </div>
    </div>
  );
}
