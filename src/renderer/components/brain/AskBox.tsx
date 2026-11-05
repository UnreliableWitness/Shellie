import { useState, type FormEvent } from 'react';
import type { TerminalDef } from '../../../shared/types';
import { useStore } from '../../store';
import { openBrainTerminal, trackBrain } from './brainActions';

/** A question for the brain's read-only `/ask` skill, sent to the brain terminal the caller then shows. */
export function AskBox({
  brainId,
  onTerminal,
  initiallyOpen = false,
}: {
  brainId: string;
  onTerminal: (def: TerminalDef) => void;
  initiallyOpen?: boolean;
}) {
  const notify = useStore((s) => s.notify);
  const [asking, setAsking] = useState(initiallyOpen);
  const [question, setQuestion] = useState('');
  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    trackBrain('ask');
    // The read-only ask skill: index first, cited answer, nothing written.
    const def = await openBrainTerminal(brainId, notify, null, `/ask ${q}`);
    if (!def) return;
    onTerminal(def);
    setQuestion('');
    setAsking(false);
  };
  return (
    <div className="brain-askbox">
      <button
        type="button"
        className="btn btn-sm"
        aria-expanded={asking}
        onClick={() => setAsking(!asking)}
      >
        Ask
      </button>
      {asking && (
        <form className="brain-ask" onSubmit={(e) => void ask(e)}>
          <input
            className="field"
            aria-label="Question"
            placeholder="Ask the brain"
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-sm"
            disabled={!question.trim()}
          >
            Send
          </button>
        </form>
      )}
    </div>
  );
}
