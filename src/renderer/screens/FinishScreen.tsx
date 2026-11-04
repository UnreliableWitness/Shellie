import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  FinishChecks,
  FinishOptions,
  FinishRowResult,
  WorkspaceAction,
  WorkspaceCheck,
} from '../../shared/types';
import {
  activeWorkspaces,
  dropsAtFinish,
  hasNoRepo,
  HOME_ID,
} from '../../shared/workspaces';
import { gitAuthHintFromText, remoteHost } from '../../shared/gitAuth';
import { LEAK_IN_BRANCH, LEAK_UNCHECKED } from '../../shared/secrets';
import { api, tryInvoke } from '../api';
import { GitAuthNotice } from '../components/GitAuthNotice';
import {
  PrDescriptionField,
  type PrDraft,
} from '../components/PrDescriptionField';
import { eur, plural } from '../format';
import { useTaskUsage } from '../hooks/useTaskUsage';
import { useTaskBrain } from '../hooks/useBrains';
import { trackBrain } from '../components/brain/brainActions';
import { TimeSpentSection } from '../components/TimeSpentSection';
import { useEstimateHours } from '../hooks/useEstimateHours';
import { useTaskTime } from '../hooks/useTaskTime';
import { PageHeader } from '../components/ui';
import { useEscape } from '../hooks/useEscape';
import type { ReviewSummary } from '../../shared/review';
import { useStore, useTaskConnectionId } from '../store';
import {
  readPrChoice,
  readPushChoice,
  writePrChoice,
  writePushChoice,
} from '../uiPrefs';
import { TOOL_LABEL } from '../../shared/time';

const ELLIPSIS = String.fromCharCode(0x2026);
const PR_FAILED = 'Pull request not created: ';
/** What main refused a push for: a stored secret in the branch, or a branch it could not check. */
const pushAnyway = (kind: 'found' | 'unchecked') =>
  `${kind === 'found' ? LEAK_IN_BRANCH : LEAK_UNCHECKED}. Push anyway?`;

type Choices = Record<string, boolean>;

/** No commits and a clean worktree: the wrong first guess, removed without a push by default. */
const noChanges = (c: WorkspaceCheck) =>
  dropsAtFinish({ ...c, uncommitted: c.uncommitted.length });

/**
 * A worktree on another branch than the task's (a long-lived `dev` joined by hand): Finish never removes it or its
 * branch, and pushes or opens a PR for it only when the user ticks that.
 */
const foreign = (c: WorkspaceCheck, taskBranch: string) =>
  c.branch !== taskBranch;

/** The row's checkbox: as the user set it, else its default (remove, or the last PR or push choice for the repo). */
const choiceOf = (
  c: WorkspaceCheck,
  choices: Choices,
  taskBranch: string,
): boolean =>
  choices[c.workspaceId] ??
  (foreign(c, taskBranch)
    ? false
    : noChanges(c)
      ? true
      : c.pr.available
        ? readPrChoice(c.repoId)
        : readPushChoice(c.repoId));

const actionOf = (
  c: WorkspaceCheck,
  choices: Choices,
  taskBranch: string,
): WorkspaceAction => {
  if (c.missing) return 'keep';
  if (foreign(c, taskBranch) && noChanges(c)) return 'keep';
  const on = choiceOf(c, choices, taskBranch);
  if (!on) return 'keep';
  return noChanges(c) ? 'drop' : c.pr.available ? 'pr' : 'push';
};

/**
 * The PR descriptions written on the Finish page, per `<taskId>:<workspaceId>`, kept for the app session so leaving
 * the page and coming back does not ask Claude Code again (Write again does).
 */
const prDrafts = new Map<string, PrDraft>();
export function clearPrDrafts(): void {
  prDrafts.clear();
}

const G = {
  WARN: String.fromCharCode(0x26a0),
  OK: String.fromCharCode(0x2713),
  UP: String.fromCharCode(0x2191),
  PLAY: String.fromCharCode(0x25b6),
};

export function FinishScreen({ taskId }: { taskId: string }) {
  const noRepo = useStore((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    return t ? hasNoRepo(t) : false;
  });
  return noRepo ? (
    <NoRepoFinishScreen taskId={taskId} />
  ) : (
    <RepoFinishScreen taskId={taskId} />
  );
}

/**
 * Finish for a task without a repo (#225): nothing to commit, push or review. It stops the terminals, can capture
 * task.md into the brain, and deletes the scratch folder only when ticked (it may hold the only copy of notes).
 */
function NoRepoFinishScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId));
  const back = useStore((s) => s.back);
  const openTask = useStore((s) => s.openTask);
  const notify = useStore((s) => s.notify);
  const brain = useTaskBrain(taskId);
  const [closeTerminals, setCloseTerminals] = useState(true);
  const [removeFolder, setRemoveFolder] = useState(false);
  const [captureTaskMd, setCaptureTaskMd] = useState(false);
  const [captureLessons, setCaptureLessons] = useState(false);
  const [busy, setBusy] = useState(false);
  useEscape(back);
  if (!task) return null;
  if (task.status !== 'ready')
    return (
      <div className="page">
        <PageHeader title="Finish task" />
        <div className="page-body finish">
          <div className="muted">{`This task is ${task.status}. Finish it once setup has succeeded; use the Setup screen to retry or remove it.`}</div>
          <div className="finish-foot">
            <button type="button" className="btn" onClick={back}>
              Keep task
            </button>
          </div>
        </div>
      </div>
    );
  const nTerm = task.terminals.length;
  const finish = async () => {
    setBusy(true);
    const ok = await tryInvoke(async () => {
      await api().invoke('tasks:finish', taskId, {
        closeTerminals: closeTerminals && nTerm > 0,
        removeWorktree: removeFolder,
        deleteBranch: false,
        ...(brain && captureTaskMd ? { captureTaskMd: true } : {}),
        ...(brain && captureLessons ? { captureLessons: true } : {}),
      });
      return true;
    }, notify);
    setBusy(false);
    const now = useStore.getState().screen;
    if (ok && now.kind === 'finish' && now.taskId === taskId) openTask(taskId);
  };
  return (
    <div className="page">
      <PageHeader title="Finish task" />
      <div className="page-body finish">
        <div className="muted">
          {task.workItem
            ? `${task.workItem.type} ${task.workItem.id} ${task.workItem.title}`
            : task.name}{' '}
          <span className="small">No repo</span>
        </div>
        <div className="finish-section">
          <h2>Clean up</h2>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={closeTerminals && nTerm > 0}
              disabled={nTerm === 0}
              onChange={(e) => setCloseTerminals(e.target.checked)}
            />
            {`Close ${plural(nTerm, 'terminal')}${nTerm > 0 ? ` (${task.terminals.map((t) => t.label).join(', ')})` : ''}`}
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={removeFolder}
              onChange={(e) => setRemoveFolder(e.target.checked)}
            />
            Delete the folder{' '}
            <span className="mono small">{task.worktreePath}</span>
          </label>
          {removeFolder && !closeTerminals && nTerm > 0 && (
            <div className="muted small">
              Deleting the folder closes its terminals too.
            </div>
          )}
          {brain && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={captureTaskMd}
                onChange={(e) => {
                  if (e.target.checked) trackBrain('capture-option');
                  setCaptureTaskMd(e.target.checked);
                }}
              />
              Capture task.md into the brain
            </label>
          )}
          {brain && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={captureLessons}
                onChange={(e) => {
                  if (e.target.checked) trackBrain('lessons-option');
                  setCaptureLessons(e.target.checked);
                }}
              />
              Save what this task taught into the brain
            </label>
          )}
        </div>
        <div className="finish-foot">
          <button type="button" className="btn" onClick={back}>
            Keep task
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void finish()}
          >
            Finish task
          </button>
        </div>
      </div>
    </div>
  );
}

function RepoFinishScreen({ taskId }: { taskId: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId));
  const back = useStore((s) => s.back);
  const openTask = useStore((s) => s.openTask);
  const notify = useStore((s) => s.notify);
  const repos = useStore((s) => s.repos);
  const connections = useStore((s) => s.connections);
  const [checks, setChecks] = useState<FinishChecks | null>(null);
  const [review, setReview] = useState<ReviewSummary | null>(null);
  useEffect(() => {
    let live = true;
    void api()
      .invoke('review:summary', taskId)
      .then((r) => live && setReview(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [taskId]);
  const [closeTerminals, setCloseTerminals] = useState(true);
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const brain = useTaskBrain(taskId);
  const [captureTaskMd, setCaptureTaskMd] = useState(false);
  const [captureLessons, setCaptureLessons] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checksFailed, setChecksFailed] = useState<string | null>(null);
  const [pr, setPr] = useState<{
    available: boolean;
    reason: string | null;
    target: string | null;
  } | null>(null);
  // Shellie asks every time: unchecked until the user has chosen once for this repo.
  const [prChoice, setPrChoice] = useState(() =>
    readPrChoice(task?.repoId ?? ''),
  );
  const [finishError, setFinishError] = useState<string | null>(null);
  // Finish waits for the PR availability, else a stored yes would be sent as no.
  const [prLoaded, setPrLoaded] = useState(false);
  // With several repos: each row's checkbox once the user touched it.
  const [rowChoice, setRowChoice] = useState<Choices>({});
  // Each row's outcome of a Finish that stopped before cleanup.
  const [results, setResults] = useState<FinishRowResult[] | null>(null);
  /** Single repo: ticked after main refused the push for a stored secret, so the next Finish pushes anyway. */
  const [confirmLeak, setConfirmLeak] = useState(false);
  /** Several repos: the same, per workspace whose row was refused. */
  const [confirmRows, setConfirmRows] = useState<Choices>({});
  /** Why main refused the single-repo push, read from its error. */
  const singleLeak: 'found' | 'unchecked' | null = finishError?.includes(
    LEAK_IN_BRANCH,
  )
    ? 'found'
    : finishError?.includes(LEAK_UNCHECKED)
      ? 'unchecked'
      : null;
  const ready = task?.status === 'ready';
  const usage = useTaskUsage(ready ? taskId : null);
  const {
    time,
    error: timeError,
    reload: reloadTime,
  } = useTaskTime(ready ? taskId : null);
  // The work item's connection is the task's own; the home repo may have none or have been dropped.
  const connectionId = useTaskConnectionId(task ?? null);
  const workItemId = task?.workItem?.id ?? null;
  const estimateHours = useEstimateHours(connectionId, workItemId, time, ready);
  // The starting value is fixed when the time first loads: a later refetch updates the marks, never the booking.
  const [frozenTime, setFrozenTime] = useState<number | undefined>();
  const [chosenTime, setChosenTime] = useState<number | null | undefined>();
  if (time && frozenTime === undefined)
    setFrozenTime(
      time.booking
        ? time.booking.bookedSeconds + time.measuredSinceReopenSeconds
        : time.activeSeconds,
    );
  const bookValue =
    chosenTime === undefined ? (frozenTime ?? null) : chosenTime;
  // Finish waits for the time (or an explicit "without booking"), and for a valid entry.
  const timeBlocks = !time || bookValue === null;

  // The workspaces Finish would open a PR for: each gets a "what changed and why" (#111).
  const multiTask = task
    ? activeWorkspaces(task).length > 1 || task.homeDropped
    : false;
  const prWorkspaces =
    !task || !ready
      ? []
      : multiTask
        ? (checks?.workspaces ?? [])
            .filter((c) => actionOf(c, rowChoice, task.branch) === 'pr')
            .map((c) => c.workspaceId)
        : pr?.available && prChoice
          ? [HOME_ID]
          : [];
  const [drafts, setDrafts] = useState<Record<string, PrDraft>>(() =>
    Object.fromEntries(
      [...prDrafts]
        .filter(([k]) => k.startsWith(`${taskId}:`))
        .map(([k, d]) => [k.slice(taskId.length + 1), d]),
    ),
  );
  // A newer request (Write again) or Skip makes an older answer stale.
  const draftRuns = useRef(new Map<string, number>());
  const setDraft = (workspaceId: string, d: PrDraft) => {
    prDrafts.set(`${taskId}:${workspaceId}`, d);
    setDrafts((all) => ({ ...all, [workspaceId]: d }));
  };
  const writeDraft = (workspaceId: string) => {
    const run = (draftRuns.current.get(workspaceId) ?? 0) + 1;
    draftRuns.current.set(workspaceId, run);
    setDraft(workspaceId, { status: 'writing', text: '', error: null });
    void api()
      .invoke('tasks:prSummary', taskId, workspaceId)
      .catch((e: unknown) => ({
        text: null,
        error: e instanceof Error ? e.message : 'unknown error',
      }))
      .then((r) => {
        if (draftRuns.current.get(workspaceId) !== run) return;
        setDraft(
          workspaceId,
          r.text
            ? { status: 'ready', text: r.text, error: null }
            : { status: 'failed', text: '', error: r.error },
        );
      });
  };
  const skipDraft = (workspaceId: string) => {
    draftRuns.current.set(
      workspaceId,
      (draftRuns.current.get(workspaceId) ?? 0) + 1,
    );
    setDraft(workspaceId, { status: 'skipped', text: '', error: null });
  };
  const prWorkspacesKey = prWorkspaces.join('|');
  useEffect(() => {
    for (const id of prWorkspaces)
      if (!prDrafts.has(`${taskId}:${id}`)) writeDraft(id);
    // Runs when the set of PR workspaces changes; writeDraft only closes over taskId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prWorkspacesKey, taskId]);
  const draftWriting = prWorkspaces.some(
    (id) => drafts[id]?.status === 'writing',
  );
  const prSummaries = Object.fromEntries(
    prWorkspaces
      .map((id) => [id, drafts[id]?.text.trim() ?? ''] as const)
      .filter(([, text]) => text.length > 0),
  );
  const prField = (workspaceId: string) => {
    const d = drafts[workspaceId];
    if (!d) return null;
    return (
      <PrDescriptionField
        draft={d}
        onChange={(text) => setDraft(workspaceId, { ...d, text })}
        onRewrite={() => writeDraft(workspaceId)}
        onSkip={() => skipDraft(workspaceId)}
      />
    );
  };

  const loadChecks = async (isLive: () => boolean) => {
    const c = await tryInvoke(async () => {
      try {
        return await api().invoke('tasks:finishChecks', taskId);
      } catch (e) {
        if (isLive()) {
          setChecks(null);
          setChecksFailed(e instanceof Error ? e.message : 'unknown error');
        }
        throw e;
      }
    }, notify);
    if (isLive() && c) {
      setChecks(c);
      setChecksFailed(null);
    }
    return c ?? null;
  };

  useEffect(() => {
    if (!ready) return;
    let live = true;
    void loadChecks(() => live);
    void tryInvoke(
      () => api().invoke('tasks:prAvailability', taskId),
      notify,
    ).then((a) => {
      if (!live) return;
      if (a) setPr(a);
      setPrLoaded(true);
    });
    return () => {
      live = false;
    };
    // loadChecks only closes over taskId and notify, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, notify, ready]);

  useEscape(back);

  const stillHere = () => {
    const now = useStore.getState().screen;
    return now.kind === 'finish' && now.taskId === taskId;
  };

  if (!task) return null;

  if (!ready) {
    return (
      <div className="page">
        <PageHeader title="Finish task" />
        <div className="page-body finish">
          <div className="muted">{`This task is ${task.status}. Finish it once setup has succeeded; use the Setup screen to retry or remove it.`}</div>
          <div className="finish-foot">
            <button type="button" className="btn" onClick={back}>
              Keep task
            </button>
          </div>
        </div>
      </div>
    );
  }

  const openGit = async (
    label: string,
    command: string,
    workspaceId?: string,
  ) => {
    const opened = await tryInvoke(
      () =>
        api().invoke('terminals:open', taskId, {
          kind: 'run',
          label,
          command,
          ...(workspaceId ? { workspaceId } : {}),
        }),
      notify,
    );
    if (opened && stillHere()) openTask(taskId);
  };

  const createPr = Boolean(pr?.available && prChoice);

  /** Whether finishing without the PR path would discard work, exactly as the main button judges it. */
  const dirtyWith = (
    c: FinishChecks | null,
    failed: boolean,
    withPr: boolean,
  ) =>
    failed
      ? true
      : c
        ? c.uncommitted.length > 0 || (c.unpushed > 0 && !withPr)
        : false;

  /**
   * Runs Finish with the page's options. `shown` puts an expected failure on the page and returns true; any other
   * error is rethrown as a notice.
   */
  const runFinish = async (
    options: Pick<FinishOptions, 'createPullRequest' | 'workspaces'>,
    withoutTime: boolean,
    shown: (e: unknown) => boolean | Promise<boolean>,
  ) => {
    setBusy(true);
    setFinishError(null);
    let failed = false;
    // Only while the refusal is on the page: a confirm never carries over to a Finish that has not been refused.
    const confirmed = singleLeak !== null && confirmLeak;
    const ok = await tryInvoke(async () => {
      try {
        await api().invoke('tasks:finish', taskId, {
          ...(confirmed ? { confirmLeak: true } : {}),
          closeTerminals: closeTerminals && nTerm > 0,
          removeWorktree,
          deleteBranch,
          ...options,
          ...(brain && captureTaskMd ? { captureTaskMd: true } : {}),
          ...(brain && captureLessons ? { captureLessons: true } : {}),
          ...(Object.keys(prSummaries).length > 0 ? { prSummaries } : {}),
          ...(!withoutTime && time && bookValue !== null
            ? { bookedSeconds: bookValue }
            : {}),
        });
      } catch (e) {
        if (!(await shown(e))) throw e;
        failed = true;
        return false;
      }
      return true;
    }, notify);
    // A push that went through changes what is unpushed; the fallback below must judge fresh checks.
    if (failed) await loadChecks(stillHere);
    setBusy(false);
    // Only when the user is still here: Escape or the nav may have taken them elsewhere meanwhile.
    if (ok && stillHere()) openTask(taskId);
  };

  const finish = async (withoutPr = false, withoutTime = false) => {
    // The choice is saved when Finish is clicked, not on every toggle.
    if (pr?.available && !withoutPr && task.repoId)
      writePrChoice(task.repoId, prChoice);
    await runFinish(
      { createPullRequest: createPr && !withoutPr },
      withoutTime,
      (e) => {
        const m = e instanceof Error ? e.message : '';
        if (!m.includes(PR_FAILED)) return false;
        setFinishError(m.slice(m.indexOf(PR_FAILED)));
        return true;
      },
    );
  };

  /**
   * Without the PR, unpushed commits are a risk again. When dropping the PR would discard work, untick
   * the box instead of finishing: the page then shows the same warnings and danger button as a normal
   * Finish, and that button is the confirmation.
   */
  const finishWithoutPr = async () => {
    if (dirtyWith(checks, Boolean(checksFailed), false)) {
      setPrChoice(false);
      setFinishError(null);
      return;
    }
    await finish(true);
  };

  // A task with other repos finishes per workspace; a single-repo task keeps the page as it was. Repos dropped at
  // an earlier Finish do not count, but a dropped home does: the single-repo path works on the home.
  const multi = multiTask;
  // The single-repo push error reaches the page as text; the repo's connection is the one whose token git used.
  const singleConnectionId =
    repos.find((r) => r.id === task.repoId)?.connectionId ?? null;
  const singleOrgUrl = connections.find(
    (c) => c.id === singleConnectionId,
  )?.organizationUrl;
  const singleAuth =
    !multi && finishError
      ? gitAuthHintFromText(finishError, {
          connectionId: singleConnectionId,
          path: task.worktreePath,
          fallbackHost: singleOrgUrl ? remoteHost(singleOrgUrl) : null,
        })
      : null;
  const taskBranch = task.branch;
  const rows = checks?.workspaces ?? [];

  /** Whether finishing with these row choices would discard uncommitted work or unpushed commits. */
  const dirtyRows = (
    list: WorkspaceCheck[],
    failed: boolean,
    choices: Choices,
  ) =>
    failed ||
    list.some((c) => {
      const action = actionOf(c, choices, taskBranch);
      // A row on another branch is kept as is: nothing of it is discarded.
      if (c.missing || action === 'drop' || foreign(c, taskBranch))
        return false;
      return c.uncommitted.length > 0 || (c.unpushed > 0 && action === 'keep');
    });

  const finishRows = async (
    choices: Choices,
    withoutPr = false,
    withoutTime = false,
  ) => {
    setResults(null);
    // The choices are saved when Finish is clicked; leaving out a failed PR is not a new preference.
    if (!withoutPr)
      for (const c of rows)
        if (!c.missing && !noChanges(c) && !foreign(c, taskBranch))
          (c.pr.available ? writePrChoice : writePushChoice)(
            c.repoId,
            choiceOf(c, choices, taskBranch),
          );
    const workspaces =
      rows.length > 0
        ? rows.map((c) => ({
            workspaceId: c.workspaceId,
            action: actionOf(c, choices, taskBranch),
            // Only a row whose push was refused, and only once ticked under it.
            ...(confirmRows[c.workspaceId] &&
            results?.some((r) => r.workspaceId === c.workspaceId && r.leak)
              ? { confirmLeak: true }
              : {}),
          }))
        : // Without checks nothing is pushed: every workspace is kept and cleaned up per the options.
          activeWorkspaces(task).map((w) => ({
            workspaceId: w.id,
            action: 'keep' as const,
          }));
    await runFinish({ workspaces }, withoutTime, async () => {
      // Main keeps each row's outcome; without a failed row this is another error, shown as a notice.
      const outcome = await api()
        .invoke('tasks:finishResults', taskId)
        .catch(() => null);
      const failed = outcome?.filter((r) => !r.ok) ?? [];
      if (!outcome || failed.length === 0) return false;
      setResults(outcome);
      setFinishError(
        `Finish stopped before cleanup: ${plural(failed.length, 'repo')} failed. Nothing was removed.`,
      );
      return true;
    });
  };

  /** Like the single-repo Finish without PR, for the failed rows only: untick them, and finish if nothing is lost. */
  const finishRowsWithoutPr = async () => {
    const next = { ...rowChoice };
    for (const r of results ?? []) if (!r.ok) next[r.workspaceId] = false;
    setRowChoice(next);
    if (dirtyRows(rows, Boolean(checksFailed), next)) {
      setFinishError(null);
      setResults(null);
      return;
    }
    await finishRows(next, true);
  };

  const setRow = (id: string, on: boolean) => {
    setRowChoice((c) => ({ ...c, [id]: on }));
    // A stale error's Retry would otherwise run with the new choice and no fresh look.
    setFinishError(null);
    setResults(null);
  };

  /** After the task's repos changed, the rows are judged again from fresh checks. */
  const reloadRows = async () => {
    setFinishError(null);
    setResults(null);
    await loadChecks(stillHere);
  };

  const addWorktree = async () => {
    const folder = await tryInvoke(
      () => api().invoke('repos:pickFolder'),
      notify,
    );
    if (!folder) return;
    const added = await tryInvoke(
      () => api().invoke('tasks:addWorkspace', taskId, folder),
      notify,
    );
    if (added) await reloadRows();
  };

  const removeRow = async (workspaceId: string) => {
    const removed = await tryInvoke(async () => {
      await api().invoke('tasks:removeWorkspace', taskId, workspaceId);
      return true;
    }, notify);
    if (removed) await reloadRows();
  };

  const dirty = multi
    ? dirtyRows(rows, Boolean(checksFailed), rowChoice)
    : dirtyWith(checks, Boolean(checksFailed), createPr);
  const nTerm = task.terminals.length;
  const terminalLabels = task.terminals.map((t) => t.label).join(', ');

  return (
    <div className="page">
      <PageHeader title="Finish task" />
      <div className="page-body finish">
        <div className="muted">
          {task.workItem
            ? `${task.workItem.type} ${task.workItem.id} ${task.workItem.title}`
            : task.name}{' '}
          <span className="mono small">{task.branch}</span>
        </div>

        <div className="finish-section">
          <h2>Safety checks</h2>
          {review && (review.notViewed > 0 || review.unresolved > 0) && (
            <Check
              tone="warn"
              glyph={G.WARN}
              actions={
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => useStore.getState().openChanges(taskId)}
                >
                  Review changes
                </button>
              }
            >
              {[
                review.notViewed > 0 &&
                  `${plural(review.notViewed, 'file')} not viewed`,
                review.unresolved > 0 &&
                  `${plural(review.unresolved, 'comment')} unresolved`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Check>
          )}
          {!checks && !checksFailed && (
            <div className="muted">Checking{ELLIPSIS}</div>
          )}
          {checksFailed && (
            <Check
              tone="warn"
              glyph={G.WARN}
            >{`Could not inspect the worktree: ${checksFailed}. You can still clean up.`}</Check>
          )}
          {checks &&
            multi &&
            rows.map((c) => (
              <WorkspaceRow
                key={c.workspaceId}
                check={c}
                on={choiceOf(c, rowChoice, taskBranch)}
                action={actionOf(c, rowChoice, taskBranch)}
                otherBranch={foreign(c, taskBranch)}
                onToggle={(on) => setRow(c.workspaceId, on)}
                openGit={openGit}
                result={results?.find((r) => r.workspaceId === c.workspaceId)}
                confirmLeak={confirmRows[c.workspaceId] ?? false}
                onConfirmLeak={(on) =>
                  setConfirmRows((m) => ({ ...m, [c.workspaceId]: on }))
                }
                prField={
                  actionOf(c, rowChoice, taskBranch) === 'pr'
                    ? prField(c.workspaceId)
                    : null
                }
                busy={busy}
                onRemove={
                  c.workspaceId === HOME_ID
                    ? undefined
                    : () => void removeRow(c.workspaceId)
                }
              />
            ))}
          {(checks || checksFailed) && (
            <div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void addWorktree()}
              >
                Add a worktree{ELLIPSIS}
              </button>
            </div>
          )}
          {checks &&
            !multi &&
            (checks.uncommitted.length > 0 ? (
              <Check
                tone="warn"
                glyph={G.WARN}
                actions={
                  <button
                    type="button"
                    className="btn btn-warn btn-sm"
                    onClick={() =>
                      openGit('git commit', 'git add -A && git commit')
                    }
                  >
                    Commit{ELLIPSIS}
                  </button>
                }
              >
                <div className="title">
                  {plural(checks.uncommitted.length, 'uncommitted change')}
                </div>
                <div className="mono small files">
                  {checks.uncommitted
                    .map((f) => `${f.status} ${f.path}`)
                    .join('\n')}
                </div>
              </Check>
            ) : (
              <Check tone="ok" glyph={G.OK}>
                No uncommitted changes
              </Check>
            ))}
          {checks &&
            !multi &&
            (checks.unpushed > 0 && !createPr ? (
              <Check
                tone="warn"
                glyph={G.UP}
                actions={
                  <button
                    type="button"
                    className="btn btn-warn btn-sm"
                    onClick={() =>
                      openGit('git push', `git push -u origin ${task.branch}`)
                    }
                  >
                    Push
                  </button>
                }
              >
                <div className="title">{`${plural(checks.unpushed, 'commit')} not pushed`}</div>
              </Check>
            ) : checks.unpushed > 0 ? (
              <Check tone="ok" glyph={G.UP}>
                {`${plural(checks.unpushed, 'commit')} will be pushed for the pull request`}
              </Check>
            ) : (
              <Check tone="ok" glyph={G.OK}>
                Nothing to push
              </Check>
            ))}
          {checks &&
            (checks.runningTerminals > 0 ? (
              <Check tone="warn" glyph={G.PLAY}>
                <div className="title">{`${plural(checks.runningTerminals, 'terminal')} still running`}</div>
                <div className="small">
                  They are closed when you finish, unless you untick it below.
                </div>
              </Check>
            ) : (
              <Check tone="ok" glyph={G.OK}>
                No running processes besides this task's terminals
              </Check>
            ))}
        </div>

        <div className="finish-section">
          <h2>AI usage</h2>
          {usage && usage.sessions.length > 0 ? (
            <div>
              <div className="amount-line">{`${eur(usage.billable.costEur)} billable`}</div>
              {(['claude-code', 'copilot-cli', 'opencode'] as const)
                .filter((t) => usage.byTool[t].sessions > 0)
                .map((t) => (
                  <div
                    key={t}
                    className="small muted"
                  >{`${t === 'opencode' ? 'OpenCode' : TOOL_LABEL[t]} ${eur(usage.byTool[t].costEur)} over ${plural(usage.byTool[t].sessions, 'session')}`}</div>
                ))}
            </div>
          ) : (
            <div className="muted">No AI usage captured for this task.</div>
          )}
        </div>

        {time ? (
          <TimeSpentSection
            task={task}
            time={time}
            estimateHours={estimateHours}
            value={bookValue}
            onChange={setChosenTime}
          />
        ) : (
          <div className="finish-section">
            <h2>Time spent</h2>
            {timeError ? (
              <Check
                tone="warn"
                glyph={G.WARN}
                role="alert"
                actions={
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={reloadTime}
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      className="btn btn-subtle btn-sm"
                      disabled={
                        busy ||
                        (!multi && !prLoaded) ||
                        (!checks && !checksFailed)
                      }
                      onClick={() =>
                        multi
                          ? void finishRows(rowChoice, false, true)
                          : void finish(false, true)
                      }
                    >
                      Finish without booking time
                    </button>
                  </>
                }
              >
                Time could not be loaded
              </Check>
            ) : (
              <div className="muted">Loading time{ELLIPSIS}</div>
            )}
          </div>
        )}

        <div className="finish-section">
          <h2>Clean up</h2>
          {pr && !multi && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={createPr}
                disabled={!pr.available}
                onChange={(e) => {
                  setPrChoice(e.target.checked);
                  // A stale error's Retry would otherwise run with the new choice and no fresh look.
                  setFinishError(null);
                }}
              />
              {pr.available
                ? `Create a draft pull request into ${pr.target}`
                : 'Create a draft pull request'}
              {!pr.available && pr.reason && (
                <>
                  {' '}
                  <span className="muted small">{pr.reason}</span>
                </>
              )}
            </label>
          )}
          {!multi && createPr && prField(HOME_ID)}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={closeTerminals && nTerm > 0}
              disabled={nTerm === 0}
              onChange={(e) => setCloseTerminals(e.target.checked)}
            />
            {`Close ${plural(nTerm, 'terminal')}${nTerm > 0 ? ` (${terminalLabels})` : ''}`}
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={removeWorktree}
              onChange={(e) => setRemoveWorktree(e.target.checked)}
            />
            {multi ? 'Remove worktree folders' : 'Remove worktree folder'}
          </label>
          {removeWorktree && !closeTerminals && nTerm > 0 && (
            <div className="muted small">
              Removing the worktree folder closes its terminals too.
            </div>
          )}
          {multi &&
            !removeWorktree &&
            !closeTerminals &&
            nTerm > 0 &&
            rows.some((c) => actionOf(c, rowChoice, taskBranch) === 'drop') && (
              <div className="muted small">
                Removing a repo without changes closes the terminals too.
              </div>
            )}
          {!removeWorktree && deleteBranch && (
            <div className="muted small">
              The branch cannot be deleted while its worktree folder exists.
              Tick &quot;Remove worktree folder&quot; too, or untick this.
            </div>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(e) => setDeleteBranch(e.target.checked)}
            />
            {multi ? (
              'Delete local branches'
            ) : (
              <>
                Delete local branch{' '}
                <span className="mono small">{task.branch}</span>
              </>
            )}
          </label>
          {brain && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={captureTaskMd}
                  onChange={(e) => {
                    if (e.target.checked) trackBrain('capture-option');
                    setCaptureTaskMd(e.target.checked);
                  }}
                />
                Capture task.md into the brain
              </label>
              <div className="muted small">
                Adds this task&apos;s task.md as a source and runs a capture.
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={captureLessons}
                  onChange={(e) => {
                    if (e.target.checked) trackBrain('lessons-option');
                    setCaptureLessons(e.target.checked);
                  }}
                />
                Save what this task taught into the brain
              </label>
              <div className="muted small">
                A digest of this task&apos;s Claude sessions becomes a source
                and the brain writes lesson pages from it.
              </div>
            </>
          )}
        </div>

        {finishError && (
          <Check
            tone="warn"
            glyph={G.WARN}
            role="alert"
            actions={
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    multi ? void finishRows(rowChoice) : void finish()
                  }
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="btn btn-subtle btn-sm"
                  disabled={busy}
                  onClick={() =>
                    multi ? void finishRowsWithoutPr() : void finishWithoutPr()
                  }
                >
                  Finish without PR
                </button>
              </>
            }
          >
            {finishError}
          </Check>
        )}
        {singleLeak && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmLeak}
              disabled={busy}
              onChange={(e) => setConfirmLeak(e.target.checked)}
            />
            {pushAnyway(singleLeak)}
          </label>
        )}
        {singleAuth && <GitAuthNotice hint={singleAuth} command="git push" />}

        <div className="finish-foot">
          <button type="button" className="btn" onClick={back}>
            Keep task
          </button>
          <button
            type="button"
            className={dirty ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={
              busy ||
              (!multi && !prLoaded) ||
              timeBlocks ||
              draftWriting ||
              (!checks && !checksFailed)
            }
            onClick={() => (multi ? void finishRows(rowChoice) : void finish())}
          >
            {checksFailed
              ? 'Clean up without checks'
              : dirty
                ? 'Discard changes and clean up'
                : 'Finish and clean up'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One line of the safety checks: a glyph, what was found, and the buttons that fix it. */
function Check({
  tone,
  glyph,
  role,
  actions,
  children,
}: {
  tone: 'ok' | 'warn';
  glyph: string;
  role?: 'alert';
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`check check-${tone}`} role={role}>
      <span aria-hidden="true">{glyph}</span>
      <div className="body">{children}</div>
      {actions}
    </div>
  );
}

/** One repo of a task on the Finish page: what it holds and what Finish will do with it. */
function WorkspaceRow({
  check: c,
  on,
  action,
  onToggle,
  openGit,
  result,
  busy,
  onRemove,
  otherBranch,
  prField,
  confirmLeak,
  onConfirmLeak,
}: {
  check: WorkspaceCheck;
  on: boolean;
  action: WorkspaceAction;
  /** Not on the task's branch: kept as is, never removed; push or PR only when ticked. */
  otherBranch: boolean;
  onToggle: (on: boolean) => void;
  openGit: (label: string, command: string, workspaceId?: string) => void;
  /** What the last Finish did with this row, when it stopped before cleanup. */
  result?: FinishRowResult;
  busy: boolean;
  /** Absent for the home workspace, which stays in the task. */
  onRemove?: () => void;
  /** The PR's description field, when Finish opens a PR for this repo. */
  prField?: ReactNode;
  /** Push anyway, after main refused this row's push for a stored secret. */
  confirmLeak: boolean;
  onConfirmLeak: (on: boolean) => void;
}) {
  const done = result?.ok
    ? result.pullRequest
      ? `Pull request #${result.pullRequest.id} ${result.pullRequest.linked ? 'linked' : 'created'}`
      : result.action === 'push' && result.pushed
        ? 'Pushed'
        : null
    : null;
  return (
    <div className="finish-workspace" role="group" aria-label={c.repoName}>
      <div className="finish-workspace-head">
        <strong>{c.repoName}</strong>{' '}
        <span className="mono small">{c.branch}</span>{' '}
        {!c.missing && (
          <span className="muted small">
            {c.commits > 0
              ? plural(c.commits, 'commit')
              : c.baseKnown
                ? 'No commits'
                : 'Changes unknown'}
          </span>
        )}
        {onRemove && (
          <button
            type="button"
            className="btn btn-subtle btn-sm"
            disabled={busy}
            onClick={onRemove}
          >
            Remove from task
          </button>
        )}
      </div>
      {done && (
        <Check tone="ok" glyph={G.OK}>
          {done}
        </Check>
      )}
      {result && !result.ok && (
        <Check tone="warn" glyph={G.WARN}>
          {result.error}
        </Check>
      )}
      {result && !result.ok && result.auth && (
        <GitAuthNotice hint={result.auth} command="git push" />
      )}
      {result && !result.ok && result.leak && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={confirmLeak}
            disabled={busy}
            onChange={(e) => onConfirmLeak(e.target.checked)}
          />
          {pushAnyway(result.leak)}
        </label>
      )}
      {c.missing ? (
        <div className="muted small">Folder missing, skipped</div>
      ) : (
        <>
          {c.uncommitted.length > 0 && (
            <Check
              tone="warn"
              glyph={G.WARN}
              actions={
                <button
                  type="button"
                  className="btn btn-warn btn-sm"
                  onClick={() =>
                    openGit(
                      'git commit',
                      'git add -A && git commit',
                      c.workspaceId,
                    )
                  }
                >
                  Commit{ELLIPSIS}
                </button>
              }
            >
              <div className="title">
                {plural(c.uncommitted.length, 'uncommitted change')}
              </div>
              <div className="mono small files">
                {c.uncommitted.map((f) => `${f.status} ${f.path}`).join('\n')}
              </div>
            </Check>
          )}
          {otherBranch && (
            <div className="muted small">{`Not this task's branch (${c.branch}): kept as is`}</div>
          )}
          {c.unpushed > 0 && action === 'keep' && !otherBranch && (
            <Check
              tone="warn"
              glyph={G.UP}
              actions={
                <button
                  type="button"
                  className="btn btn-warn btn-sm"
                  onClick={() =>
                    openGit(
                      'git push',
                      `git push -u origin ${c.branch}`,
                      c.workspaceId,
                    )
                  }
                >
                  Push
                </button>
              }
            >
              <div className="title">{`${plural(c.unpushed, 'commit')} not pushed`}</div>
            </Check>
          )}
          {!(otherBranch && noChanges(c)) && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => onToggle(e.target.checked)}
              />
              {noChanges(c)
                ? 'Remove, no changes (no push)'
                : c.pr.available
                  ? `Create a draft pull request into ${c.pr.target}`
                  : 'Push the branch'}
            </label>
          )}
          {!noChanges(c) && !c.pr.available && c.pr.reason && (
            <div className="muted small">{`No pull request: ${c.pr.reason}`}</div>
          )}
          {prField}
          {!noChanges(c) && c.pr.available && !c.pr.linksWorkItem && (
            <div className="muted small">
              This repo is in another organization: the PR names the work item
              instead of linking it.
            </div>
          )}
        </>
      )}
    </div>
  );
}
