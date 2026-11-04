import { useEffect, useRef, useState } from 'react';
import type { SetupEvent, SetupState } from '../../shared/types';
import { isReopening } from '../../shared/workspaces';
import { api, tryInvoke } from '../api';
import { GitAuthNotice } from '../components/GitAuthNotice';
import { StepList } from '../components/StepList';
import { TaskSummaryCard } from '../components/TaskSummaryCard';
import { TaskTypeIcon } from '../components/TaskTypeIcon';
import { PageHeader } from '../components/ui';
import { useStore } from '../store';

export function applySetupEvent(state: SetupState, e: SetupEvent): SetupState {
  if (e.type === 'log') return { ...state, log: [...state.log, e.line] };
  if (e.type === 'step') {
    const steps = state.steps.map((s, i) =>
      i === e.index
        ? {
            ...s,
            status: e.status,
            detail: e.status === 'running' ? e.detail : (e.detail ?? s.detail),
            ms: e.status === 'running' ? e.ms : (e.ms ?? s.ms),
            auth: e.status === 'failed' ? e.auth : undefined,
          }
        : s,
    );
    if (e.status === 'running')
      return { ...state, steps, finished: false, ok: null, failedStep: null };
    return { ...state, steps };
  }
  return {
    ...state,
    finished: true,
    ok: e.ok,
    failedStep: e.failedStep ?? null,
  };
}

const EMPTY_STATE: SetupState = {
  steps: [],
  log: [],
  finished: false,
  ok: null,
  failedStep: null,
};

/** Applies events buffered during the snapshot fetch, skipping log lines the snapshot already holds. */
function replayPending(
  snapshot: SetupState,
  pending: SetupEvent[],
): SetupState {
  const buffered = pending.flatMap((e) => (e.type === 'log' ? [e.line] : []));
  let overlap = 0;
  for (let j = Math.min(buffered.length, snapshot.log.length); j > 0; j--) {
    const tail = snapshot.log.slice(snapshot.log.length - j);
    if (tail.every((line, i) => line === buffered[i])) {
      overlap = j;
      break;
    }
  }
  let skip = overlap;
  let state = snapshot;
  for (const e of pending) {
    if (e.type === 'log' && skip > 0) {
      skip--;
      continue;
    }
    state = applySetupEvent(state, e);
  }
  return state;
}

export function SetupScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId));
  const go = useStore((s) => s.go);
  const select = useStore((s) => s.select);
  const notify = useStore((s) => s.notify);
  const [state, setState] = useState<SetupState | null>(null);
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    let pending: SetupEvent[] | null = [];
    const off = api().on('setup', (e) => {
      if (e.taskId !== taskId) return;
      if (pending) {
        pending.push(e);
        return;
      }
      setState((prev) => (prev ? applySetupEvent(prev, e) : prev));
      if (e.type === 'finished' && e.ok) {
        select(taskId);
        go({ kind: 'task' });
      }
    });
    void tryInvoke(() => api().invoke('tasks:setupState', taskId), notify).then(
      (snapshot) => {
        const buffered = pending ?? [];
        pending = null;
        if (!live) return;
        const next = replayPending(snapshot ?? EMPTY_STATE, buffered);
        setState(next);
        if (next.finished && next.ok) {
          select(taskId);
          go({ kind: 'task' });
        }
      },
    );
    return () => {
      live = false;
      off();
    };
  }, [taskId, go, select, notify]);

  useEffect(() => {
    if (follow && logRef.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state?.log.length, follow]);

  const failedStep = state?.failedStep ?? null;
  const failedLabel =
    failedStep !== null ? state?.steps[failedStep]?.def.label : null;
  const running = state?.steps.find((s) => s.status === 'running');
  const authHint =
    failedStep !== null && state?.steps[failedStep]?.status === 'failed'
      ? state.steps[failedStep].auth
      : undefined;

  const retry = async () => {
    const ok = await tryInvoke(async () => {
      await api().invoke('tasks:retrySetup', taskId);
      return true;
    }, notify);
    if (!ok) return;
    const fresh = await tryInvoke(
      () => api().invoke('tasks:setupState', taskId),
      notify,
    );
    if (fresh) setState(fresh);
  };
  const cancel = async () => {
    const ok = await tryInvoke(async () => {
      await api().invoke('tasks:cancelSetup', taskId);
      return true;
    }, notify);
    // A cancelled reopen leaves the task on its Done page; a cancelled new task is gone.
    // The task page shows the Done page once the task is done again.
    if (ok && reopening) {
      select(taskId);
      go({ kind: 'task' });
    } else if (ok) go({ kind: 'home' });
  };

  if (!task) return <div className="empty">Task not found.</div>;
  const back = () => go({ kind: 'home' });
  const reopening = isReopening(task);

  return (
    <div className="page">
      <PageHeader
        before={<TaskTypeIcon task={task} />}
        title={task.workItem?.title ?? task.name}
        after={
          <span className="muted">
            {task.workItem
              ? `${task.workItem.type} ${task.workItem.id}`
              : 'Blank task'}
          </span>
        }
      />
      <div className="setup">
        <section className="setup-left">
          {task.setup.summary && task.repoId !== null && (
            <TaskSummaryCard
              summary={task.setup.summary}
              repoId={task.repoId}
              collapsible={
                task.status === 'ready' ||
                (state?.finished === true && state.ok === true)
              }
            />
          )}
          <div className="muted">
            {reopening
              ? task.status === 'setup-failed'
                ? 'Reopening failed. Fix the cause, then retry, or cancel: the task goes back to Done.'
                : 'Restoring the worktree and terminals of this task. You can leave this page; it keeps going in the background.'
              : task.status === 'setup-failed'
                ? 'Setup failed. Fix the cause, then retry, or remove the task.'
                : task.status === 'ready'
                  ? 'Setup finished.'
                  : 'Setting up your task. You can leave this page; it keeps going in the background.'}
          </div>
          {state ? (
            <StepList steps={state.steps} />
          ) : (
            <div className="muted">Loading...</div>
          )}
          {authHint && <GitAuthNotice hint={authHint} />}
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button type="button" className="btn" onClick={back}>
              Back to Sprint
            </button>
            {task.status === 'setup-failed' && (
              <button type="button" className="btn btn-primary" onClick={retry}>
                {failedLabel ? `Retry from ${failedLabel}` : 'Retry'}
              </button>
            )}
            <button
              type="button"
              className="btn btn-warn"
              disabled={task.status === 'setting-up'}
              onClick={cancel}
            >
              {reopening ? 'Cancel reopen' : 'Cancel and remove'}
            </button>
          </div>
        </section>
        <section className="setup-log" aria-label="Setup log">
          <div className="setup-log-head">
            <span style={{ fontWeight: 600 }}>
              {running?.def.label ??
                (state?.finished ? (state.ok ? 'Done' : 'Failed') : 'Starting')}
            </span>
            <span className="small muted">live output</span>
            <label className="checkbox small" style={{ marginLeft: 'auto' }}>
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              Follow
            </label>
          </div>
          <div className="setup-log-body" ref={logRef}>
            {(state?.log ?? []).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
