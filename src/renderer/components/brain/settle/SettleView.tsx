import { useState } from 'react';
import type {
  BrainConflicts,
  BrainPageRow,
  BrainView,
  ParkedConflictRow,
} from '../../../../shared/brain';
import { api, tryInvoke } from '../../../api';
import { useStore } from '../../../store';
import { trackBrain } from '../brainActions';
import { askedWho, forgetAsked } from './askStore';
import { ConflictCard } from './ConflictCard';
import { choiceLine } from './words';

const STATUS: Record<'pending' | 'done' | 'failed', string> = {
  pending: 'updating pages…',
  done: 'done',
  failed: 'failed',
};

function Parked({
  brain,
  row,
  onAnswered,
}: {
  brain: BrainView;
  row: ParkedConflictRow;
  onAnswered(answer: { path: string; text: string }): void;
}) {
  const notify = useStore((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const who = askedWho(brain.id, row.id);
  const add = async () => {
    trackBrain('answer');
    setBusy(true);
    const r = await tryInvoke(
      () =>
        api().invoke(
          'brain:addText',
          brain.id,
          text.trim(),
          `Answer: ${row.question}`,
          'note',
          'Answer to a conflict',
          undefined,
          { capture: false },
        ),
      notify,
    );
    if (!r?.ok) {
      setBusy(false);
      if (r && !r.ok) notify('error', r.message);
      return;
    }
    await tryInvoke(
      () => api().invoke('brain:unpark', brain.id, row.id),
      notify,
    );
    forgetAsked(brain.id, row.id);
    setBusy(false);
    onAnswered({ path: r.path, text: text.trim() });
  };
  return (
    <li className="list-row brain-settle-row">
      <span
        className={row.kind === 'scope-change' ? 'tag tag-warn' : 'tag tag-red'}
      >
        {row.kind === 'scope-change' ? 'Scope change' : 'Contradiction'}
      </span>
      <div className="grow">
        <div>{row.conflict?.question ?? row.detail}</div>
        <div className="muted small">
          {who ? `Asked ${who}` : 'Asked someone'} · {row.parkedAt.slice(0, 10)}
        </div>
        {open && (
          <div className="brain-answer">
            <label className="brain-conflict-field">
              <span>
                <strong>Their answer</strong>{' '}
                <span className="muted small">
                  Goes into the brain as a source; then you settle as usual.
                </span>
              </span>
              <textarea
                className="field"
                rows={2}
                aria-label="Their answer"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <div className="brain-conflict-foot">
              <span className="grow" />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || !text.trim()}
                onClick={() => void add()}
              >
                Add answer and settle
              </button>
            </div>
          </div>
        )}
      </div>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          trackBrain('copy-question');
          void navigator.clipboard
            ?.writeText(row.question)
            .catch(() => undefined);
        }}
      >
        Copy question
      </button>
      {!open && (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => setOpen(true)}
        >
          Got an answer
        </button>
      )}
    </li>
  );
}

/**
 * Settling conflicts: one conflict at a time when `target` names an open one, else the list of what needs you,
 * what waits on someone and what was settled.
 */
export function SettleView({
  brain,
  conflicts,
  rows,
  target,
  onTarget,
  onBack,
  onOpenPage,
}: {
  brain: BrainView;
  conflicts: BrainConflicts;
  rows: BrainPageRow[];
  target: string | null;
  onTarget(id: string | null): void;
  onBack(): void;
  onOpenPage(path: string): void;
}) {
  const notify = useStore((s) => s.notify);
  // Answers added this session, by conflict id, until it is settled.
  const [answers, setAnswers] = useState<
    Record<string, { path: string; text: string }>
  >({});
  const titles = new Map(rows.map((r) => [r.path, r.title]));
  const titleOf = (p: string) =>
    titles.get(p) ?? p.replace(/^(wiki|sources)\//, '').replace(/\.md$/, '');
  const { open, parked, settled } = conflicts;
  const index = target ? open.findIndex((c) => c.id === target) : -1;
  const row = index >= 0 ? open[index] : null;

  const head = (
    <div className="brain-settle-head">
      <button type="button" className="link small" onClick={onBack}>
        ← Add
      </button>
      <h1>Settle conflicts</h1>
      {row && (
        <button
          type="button"
          className="link small"
          onClick={() => onTarget(null)}
        >
          All conflicts
        </button>
      )}
    </div>
  );

  if (row) {
    const others = open.filter((c) => c.id !== row.id);
    return (
      <div className="brain-settle">
        {head}
        <ConflictCard
          key={row.id}
          brain={brain}
          row={row}
          position={{ index, total: open.length }}
          answer={answers[row.id] ?? null}
          titleOf={titleOf}
          onPrev={index > 0 ? () => onTarget(open[index - 1].id) : undefined}
          onNext={
            index < open.length - 1
              ? () => onTarget(open[index + 1].id)
              : undefined
          }
          onDone={() =>
            onTarget(others[Math.min(index, others.length - 1)]?.id ?? null)
          }
          onOpenPage={onOpenPage}
        />
      </div>
    );
  }

  const retry = (id: string) =>
    void tryInvoke(
      () => api().invoke('brain:settleRetry', brain.id, id),
      notify,
    );
  const nothing = open.length + parked.length + settled.length === 0;
  return (
    <div className="brain-settle">
      {head}
      {nothing && (
        <p className="muted">
          Nothing to settle. Lint raises conflicts here when pages or sources
          disagree.
        </p>
      )}
      {open.length > 0 && (
        <section
          className="brain-card"
          aria-label={`Needs you · ${open.length}`}
        >
          <h2>Needs you · {open.length}</h2>
          <ul className="list">
            {open.map((c) => (
              <li key={c.id} className="list-row brain-settle-row">
                <span
                  className={
                    c.kind === 'scope-change' ? 'tag tag-warn' : 'tag tag-red'
                  }
                >
                  {c.kind === 'scope-change' ? 'Scope change' : 'Contradiction'}
                </span>
                <div className="grow">
                  <div>{c.conflict?.question ?? c.detail}</div>
                  <div className="muted small">
                    {c.conflict
                      ? `${titleOf(c.conflict.claims.a.page)} and ${titleOf(c.conflict.claims.b.page)}`
                      : titleOf(c.page)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => onTarget(c.id)}
                >
                  Settle
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {parked.length > 0 && (
        <section
          className="brain-card"
          aria-label={`Waiting on someone · ${parked.length}`}
        >
          <h2>Waiting on someone · {parked.length}</h2>
          <ul className="list">
            {parked.map((p) => (
              <Parked
                key={p.id}
                brain={brain}
                row={p}
                onAnswered={(a) => {
                  setAnswers((all) => ({ ...all, [p.id]: a }));
                  onTarget(p.id);
                }}
              />
            ))}
          </ul>
        </section>
      )}
      {settled.length > 0 && (
        <section className="brain-card" aria-label="Settled">
          <h2>Settled</h2>
          <ul className="list">
            {settled.map((s) => (
              <li key={s.id} className="list-row brain-settle-row">
                <span className={`brain-status brain-status-${s.status} small`}>
                  {STATUS[s.status]}
                </span>
                <div className="grow">
                  <div>{s.question}</div>
                  <div className="muted small">
                    {choiceLine(s.choice, s.text)} · {s.at.slice(0, 10)}
                  </div>
                  {s.error && (
                    <span className="brain-error small">{s.error}</span>
                  )}
                </div>
                {s.page && (
                  <button
                    type="button"
                    className="link small"
                    onClick={() => onOpenPage(s.page!)}
                  >
                    Decision page
                  </button>
                )}
                {s.status === 'failed' && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => retry(s.id)}
                  >
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
