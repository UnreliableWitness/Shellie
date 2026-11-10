import { useState } from 'react';
import {
  settleReady,
  type BrainConflictRow,
  type BrainView,
  type ConflictClaim,
  type SettleDecision,
} from '../../../../shared/brain';
import { errorMessage } from '../../../../shared/errors';
import { api, tryInvoke } from '../../../api';
import { useStore } from '../../../store';
import { trackBrain, trackSettle } from '../brainActions';
import { setAskedWho } from './askStore';
import {
  CHOICE_LABEL,
  choicesFor,
  defaultQuestion,
  fileName,
  NEEDS_TEXT,
  newerOf,
  SETTLE_LABEL,
  type CardChoice,
} from './words';

export const SKILLS_NOTE = 'Update skills to settle conflicts here';

function Claim({
  label,
  claim,
  newer,
  titleOf,
  onOpenPage,
}: {
  label: string;
  claim: ConflictClaim;
  newer: boolean;
  titleOf: (p: string) => string;
  onOpenPage(path: string): void;
}) {
  const isSource = claim.page.startsWith('sources/');
  return (
    <div className="brain-claim" role="group" aria-label={label}>
      <div className="brain-claim-head">
        <span className="brain-claim-label">{label}</span>
        <span className="muted small">{titleOf(claim.page)}</span>
        {newer && <span className="tag tag-green">Newer</span>}
      </div>
      <blockquote className="brain-claim-quote">{claim.quote}</blockquote>
      {(claim.source || claim.date) && (
        <span className="muted small">
          {claim.source ? `Source: ${fileName(claim.source)}` : 'Source'}
          {claim.date ? ` · ${claim.date}` : ''}
        </span>
      )}
      <button
        type="button"
        className="link small brain-claim-open"
        onClick={() => onOpenPage(claim.page)}
      >
        {isSource ? 'Open source' : 'Open page'}
      </button>
    </div>
  );
}

/**
 * One conflict to settle: the question, both claims side by side, the agent's read, the choices (nothing chosen
 * for the person), why, and Settle; or who to ask and a question to copy, and Park.
 */
export function ConflictCard({
  brain,
  row,
  position,
  answer,
  titleOf,
  onPrev,
  onNext,
  onDone,
  onOpenPage,
}: {
  brain: BrainView;
  row: BrainConflictRow;
  /** "1 of 3" among the open conflicts; null for one opened from elsewhere. */
  position: { index: number; total: number } | null;
  /** Someone's answer, added as a source, shown above the choices and passed to the settle. */
  answer: { path: string; text: string } | null;
  titleOf: (p: string) => string;
  onPrev?: () => void;
  onNext?: () => void;
  /** Settled or parked: the view moves on. */
  onDone(): void;
  onOpenPage(path: string): void;
}) {
  const notify = useStore((s) => s.notify);
  /** Runs a call that returns nothing; false when it failed (the error is shown). */
  const attempt = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return true;
    } catch (e) {
      notify('error', errorMessage(e));
      return false;
    }
  };
  const c = row.conflict;
  const scope = row.kind === 'scope-change';
  const [choice, setChoice] = useState<CardChoice | null>(null);
  const [text, setText] = useState('');
  const [why, setWhy] = useState('');
  const [who, setWho] = useState('');
  const [question, setQuestion] = useState(() => defaultQuestion(row, titleOf));
  const [busy, setBusy] = useState(false);
  const ready = settleReady(brain);
  const newer = c ? newerOf(c.claims.a, c.claims.b) : null;
  const suggested = c?.suggestion?.pick ?? null;

  const settle = async () => {
    if (!choice || choice === 'ask') return;
    const decision: SettleDecision = {
      id: row.id,
      kind: row.kind,
      page: row.page,
      question: c?.question ?? row.detail,
      detail: row.detail,
      claims: c?.claims ?? null,
      choice,
      text: NEEDS_TEXT.has(choice) ? text.trim() : null,
      why: why.trim() || null,
      answer: answer?.path ?? null,
    };
    trackSettle({
      kind: row.kind,
      choice,
      suggested: suggested !== null && suggested === choice,
      why: decision.why !== null,
      answered: answer !== null,
    });
    setBusy(true);
    const ok = await attempt(() =>
      api().invoke('brain:settle', brain.id, decision),
    );
    setBusy(false);
    if (ok) onDone();
  };

  const park = async () => {
    trackBrain('park');
    setBusy(true);
    const ok = await attempt(() =>
      api().invoke('brain:park', brain.id, row.id, question.trim()),
    );
    setBusy(false);
    if (!ok) return;
    if (who.trim()) setAskedWho(brain.id, row.id, who.trim());
    onDone();
  };

  const copy = () => {
    trackBrain('copy-question');
    void navigator.clipboard?.writeText(question).catch(() => undefined);
  };

  const recheck = () => {
    trackBrain('recheck');
    void tryInvoke(() => api().invoke('brain:run', brain.id, 'lint'), notify);
  };

  const missingText = choice !== null && NEEDS_TEXT.has(choice) && !text.trim();
  return (
    <section
      className="brain-card brain-conflict"
      aria-labelledby="brain-conflict-q"
    >
      <div className="brain-conflict-top">
        <span className={scope ? 'tag tag-warn' : 'tag tag-red'}>
          {scope ? 'Scope change' : 'Contradiction'}
        </span>
        <span className="muted small">
          Found by lint · {row.at.slice(0, 10)}
        </span>
        <span className="grow" />
        {position && (
          <span className="muted small">{`${position.index + 1} of ${position.total}`}</span>
        )}
        {onPrev && (
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Previous conflict"
            onClick={onPrev}
          >
            ‹
          </button>
        )}
        {onNext && (
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Next conflict"
            onClick={onNext}
          >
            ›
          </button>
        )}
      </div>
      <h2 id="brain-conflict-q" className="brain-conflict-q">
        {c?.question ?? `On ${titleOf(row.page)}`}
      </h2>

      {c ? (
        <div className="brain-claims">
          <Claim
            label={scope ? 'Agreed scope' : 'Claim A'}
            claim={c.claims.a}
            newer={newer === 'a'}
            titleOf={titleOf}
            onOpenPage={onOpenPage}
          />
          <span className="brain-claims-vs muted small" aria-hidden="true">
            vs
          </span>
          <Claim
            label={scope ? 'New source' : 'Claim B'}
            claim={c.claims.b}
            newer={newer === 'b'}
            titleOf={titleOf}
            onOpenPage={onOpenPage}
          />
        </div>
      ) : (
        <div className="brain-conflict-old">
          <p>{row.detail}</p>
          <span className="muted small">
            Found before lint described both sides. Re-check asks lint to write
            it in full.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!ready}
            onClick={recheck}
          >
            Re-check
          </button>
        </div>
      )}

      {c?.suggestion?.reason && (
        <div className="brain-conflict-read">
          <span className="brain-conflict-kicker">The agent's read</span>
          <span className="small">{c.suggestion.reason}</span>
        </div>
      )}
      {answer && (
        <div className="brain-conflict-read">
          <span className="brain-conflict-kicker">Their answer</span>
          <span className="small">{answer.text}</span>
        </div>
      )}

      <fieldset className="brain-choices">
        <legend className="brain-conflict-kicker">
          {scope ? 'What do we do with the scope?' : 'What is true?'}
        </legend>
        {choicesFor(row).map((k) => (
          <label
            key={k}
            className={choice === k ? 'brain-choice is-on' : 'brain-choice'}
          >
            <input
              type="radio"
              name={`settle-${row.id}`}
              checked={choice === k}
              onChange={() => setChoice(k)}
            />
            <span>
              {CHOICE_LABEL[k]}
              {suggested === k && (
                <span className="tag tag-accent">Suggested</span>
              )}
            </span>
          </label>
        ))}
      </fieldset>

      {choice && NEEDS_TEXT.has(choice) && (
        <label className="brain-conflict-field">
          <strong>{choice === 'both' ? 'How they fit' : 'What is true'}</strong>
          <textarea
            className="field"
            rows={2}
            aria-label={choice === 'both' ? 'How they fit' : 'What is true'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      )}

      {choice === 'ask' ? (
        <div className="brain-ask">
          <label className="brain-conflict-field">
            <strong>Who can answer</strong>
            <span className="muted small">
              A name or a role; kept on this computer only
            </span>
            <input
              className="field"
              aria-label="Who can answer"
              value={who}
              onChange={(e) => setWho(e.target.value)}
            />
          </label>
          <label className="brain-conflict-field">
            <strong>The question</strong>
            <textarea
              className="field"
              rows={4}
              aria-label="The question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
          <div className="brain-conflict-foot">
            <button type="button" className="btn btn-sm" onClick={copy}>
              Copy question
            </button>
            <span className="muted small">
              Parked conflicts leave Needs you until you come back with the
              answer.
            </span>
            <span className="grow" />
            <button type="button" className="btn btn-ghost" onClick={onDone}>
              Skip for now
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !question.trim()}
              onClick={() => void park()}
            >
              {who.trim() ? `Park: waiting on ${who.trim()}` : 'Park'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <label className="brain-conflict-field">
            <span>
              <strong>Why</strong>{' '}
              <span className="muted small">
                Optional. Goes in the decision page.
              </span>
            </span>
            <textarea
              className="field"
              rows={2}
              aria-label="Why"
              value={why}
              onChange={(e) => setWhy(e.target.value)}
            />
          </label>
          <div className="brain-conflict-foot">
            {!ready ? (
              <span className="brain-error small">{SKILLS_NOTE}</span>
            ) : (
              <span className="muted small">
                Writes a decision page and updates the pages in the background;
                old claims stay as history.
              </span>
            )}
            <span className="grow" />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                trackBrain('skip');
                onDone();
              }}
            >
              Skip for now
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!ready || busy || !choice || missingText}
              onClick={() => void settle()}
            >
              {choice ? SETTLE_LABEL[choice] : 'Settle'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
