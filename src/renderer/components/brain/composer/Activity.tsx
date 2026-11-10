import { useState } from 'react';
import {
  isBookJob,
  type BrainPageRow,
  type BrainSourceRow,
  type BrainView,
} from '../../../../shared/brain';
import type { TerminalDef } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import { useStore } from '../../../store';
import { openBrainTerminal, trackBrain } from '../brainActions';
import { pagesChangedBy } from '../recent';
import { activityRows, type ActivityRow } from './activityRows';
import { modelLabel } from './ModelPicker';

type Filter = 'all' | 'needs' | 'running' | 'done';

const GROUPS: { group: ActivityRow['group']; title: string; filter: Filter }[] =
  [
    { group: 'running', title: 'Just added', filter: 'running' },
    { group: 'needs', title: 'Needs you', filter: 'needs' },
    { group: 'earlier', title: 'Earlier', filter: 'done' },
  ];

const fileName = (path: string) => path.replace(/^sources\//, '');

/**
 * What happened to what was added: captures and other jobs that run, the sources that need you (the Add badge's
 * number) and what finished, newest first, each with its actions.
 */
export function Activity({
  brain,
  sources,
  rows: pages,
  log,
  onTerminal,
  onOpenPage,
  conflicts = 0,
  parkedConflicts = 0,
  answers = [],
  onSettle,
}: {
  brain: BrainView;
  sources: BrainSourceRow[];
  rows: BrainPageRow[];
  log: string;
  onTerminal?: (def: TerminalDef) => void;
  onOpenPage: (path: string) => void;
  /** Open conflicts to settle: one row under Needs you. */
  conflicts?: number;
  /** Conflicts waiting on someone: the row stays (to come back with the answer) but they are not counted. */
  parkedConflicts?: number;
  /** Answer sources a settle will read: not waiting for a capture. */
  answers?: string[];
  /** Opens the Settle view. */
  onSettle?: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const [filter, setFilter] = useState<Filter>('all');
  const rows = activityRows(
    brain.jobs,
    sources,
    brain.health?.queuePaused ?? null,
    answers,
  );
  const count = (g: ActivityRow['group']) =>
    rows.filter((r) => r.group === g).length;
  const settleRow = conflicts + parkedConflicts > 0 && onSettle !== undefined;
  const needs = count('needs') + (settleRow ? conflicts : 0);
  const running = count('running');

  const capture = (path: string, model: string | null) =>
    tryInvoke(
      () =>
        model
          ? api().invoke('brain:run', brain.id, 'capture', path, model)
          : api().invoke('brain:run', brain.id, 'capture', path),
      notify,
    );
  const captureAll = async () => {
    trackBrain('capture');
    for (const r of rows)
      if (r.group === 'needs' && r.source)
        await capture(r.source, r.job?.model ?? null);
  };

  const tabs: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'needs', label: `Needs you · ${needs}` },
    { id: 'running', label: `Running · ${running}` },
    { id: 'done', label: 'Done' },
  ];

  return (
    <section
      className="brain-card brain-activity"
      aria-labelledby="brain-activity-h"
    >
      <div className="brain-card-head">
        <h2 id="brain-activity-h">Activity</h2>
        {needs > 0 && <span className="brain-count">Needs you · {needs}</span>}
        <span className="grow" />
        {(rows.length > 0 || settleRow) && (
          <div
            className="brain-filters"
            role="tablist"
            aria-label="Filter activity"
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={filter === t.id}
                className={filter === t.id ? 'is-on' : undefined}
                onClick={() => setFilter(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {rows.length === 0 && !settleRow && (
        <p className="muted small">Nothing added yet.</p>
      )}
      {GROUPS.filter((g) => filter === 'all' || filter === g.filter).map(
        (g) => {
          const list = rows.filter((r) => r.group === g.group);
          const withSettle = g.group === 'needs' && settleRow;
          if (list.length === 0 && !withSettle) return null;
          return (
            <div key={g.group} className="brain-activity-group">
              <div className="brain-activity-group-head">
                <h3 id={`brain-activity-${g.group}`}>{g.title}</h3>
                {g.group === 'needs' && list.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void captureAll()}
                  >
                    Capture all
                  </button>
                )}
              </div>
              <ul
                className="list brain-jobs"
                aria-labelledby={`brain-activity-${g.group}`}
              >
                {withSettle && (
                  <li className="list-row brain-job">
                    <span className="brain-status small">conflicts</span>
                    <span className="grow">
                      {conflicts > 0
                        ? `Conflicts to settle · ${conflicts}`
                        : `Conflicts waiting on someone · ${parkedConflicts}`}
                    </span>
                    <button
                      type="button"
                      className={
                        conflicts > 0 ? 'btn btn-sm btn-primary' : 'btn btn-sm'
                      }
                      onClick={onSettle}
                    >
                      {conflicts > 0 ? 'Settle' : 'Open'}
                    </button>
                  </li>
                )}
                {list.map((r) => (
                  <ActivityLine
                    key={r.key}
                    brain={brain}
                    row={r}
                    changed={r.job ? pagesChangedBy(r.job, log, pages) : []}
                    onCapture={(path, model) => {
                      trackBrain(r.job ? 'retry' : 'capture');
                      void capture(path, model);
                    }}
                    onTerminal={onTerminal}
                    onOpenPage={onOpenPage}
                  />
                ))}
              </ul>
            </div>
          );
        },
      )}
    </section>
  );
}

function ActivityLine({
  brain,
  row,
  changed,
  onCapture,
  onTerminal,
  onOpenPage,
}: {
  brain: BrainView;
  row: ActivityRow;
  /** The pages a done capture changed, from log.md. */
  changed: { label: string; path: string | null }[];
  onCapture(path: string, model: string | null): void;
  onTerminal?: (def: TerminalDef) => void;
  onOpenPage: (path: string) => void;
}) {
  const notify = useStore((s) => s.notify);
  const { job, source, reason, sourceRow } = row;
  const first = changed.find((p) => p.path)?.path;
  const status = job?.status ?? 'waiting';
  const retry = () => {
    if (!job) return;
    if (job.kind === 'capture' && job.source) {
      onCapture(job.source, job.model);
      return;
    }
    trackBrain('retry');
    const kind = job.kind;
    if (kind === 'settle') {
      void tryInvoke(
        () => api().invoke('brain:settleRetry', brain.id, job.conflict ?? ''),
        notify,
      );
      return;
    }
    void tryInvoke(
      () =>
        job.source
          ? api().invoke('brain:run', brain.id, kind, job.source)
          : api().invoke('brain:run', brain.id, kind),
      notify,
    );
  };
  const resume = async () => {
    if (!job) return;
    trackBrain('continue');
    // A job that ran on another agent than the brain's continues on its own agent.
    const def = await openBrainTerminal(
      brain.id,
      notify,
      job.sessionId,
      undefined,
      job.agent === brain.options.agent ? undefined : job.agent,
    );
    if (def) onTerminal?.(def);
  };
  const failed = job?.status === 'failed';
  return (
    <li className="list-row brain-job">
      <span className={`brain-status brain-status-${status} small`}>
        {reason?.kind === 'failed' ? 'failed' : (reason?.text ?? status)}
      </span>
      <div className="grow">
        <span>
          {source ? fileName(source) : <strong>{job?.kind}</strong>}
          {source && job && job.kind !== 'capture' && (
            <span className="muted"> · {job.kind}</span>
          )}
          {sourceRow && (
            <span className="muted small"> · {sourceRow.type}</span>
          )}
          {job?.model && (
            <span className="muted small"> · {modelLabel(job.model)}</span>
          )}
        </span>
        {failed && reason && (
          <span className="brain-error small">{reason.text}</span>
        )}
        {sourceRow?.contents && (
          <span className="muted small brain-contents">
            {sourceRow.contents}
          </span>
        )}
        {job?.status === 'done' && job.result && (
          <details className="brain-takeaways small">
            <summary>Takeaways</summary>
            <p>{job.result}</p>
          </details>
        )}
      </div>
      {first && (
        <button
          type="button"
          className="link small"
          onClick={() => onOpenPage(first)}
        >
          {changed.length === 1
            ? '1 page changed'
            : `${changed.length} pages changed`}
        </button>
      )}
      {/* A paused job runs again on Resume (Health); only a failed one is retried, never the book's: a retry would be a full sync. */}
      {failed && job && !isBookJob(job) && (
        <button type="button" className="btn btn-sm" onClick={retry}>
          Retry
        </button>
      )}
      {!job && source && (
        <button
          type="button"
          className="btn btn-sm"
          aria-label={`Capture ${source}`}
          onClick={() => onCapture(source, null)}
        >
          Capture
        </button>
      )}
      {job?.sessionId && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void resume()}
        >
          Continue in terminal
        </button>
      )}
    </li>
  );
}
