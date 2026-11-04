import { ArrowUndo16Regular } from '@fluentui/react-icons';
import { type ReactNode, useEffect, useState } from 'react';
import type { PullRequestRef, TaskSummary, TaskView } from '../../shared/types';
import {
  hasNoRepo,
  taskWorkspaces,
  type WorkspaceView,
} from '../../shared/workspaces';
import { api, tryInvoke } from '../api';
import { TaskTypeIcon } from '../components/TaskTypeIcon';
import { PageHeader, StateDot } from '../components/ui';
import { envTextClass } from '../components/secrets/environment';
import { ENVIRONMENT_LABEL } from '../../shared/secrets';
import { UsagePanel } from '../components/UsagePanel';
import { dateTime, duration, eur } from '../format';
import { useLiveWorkItem } from '../hooks/useLiveWorkItem';
import { useTaskTime } from '../hooks/useTaskTime';
import { formatDuration } from '../../shared/time';
import { useTaskUsage } from '../hooks/useTaskUsage';
import { useStore, useTaskConnectionId } from '../store';

const MINUS = String.fromCharCode(0x2212);

/** The pull request as Azure DevOps has it now; starts from the stored one and refreshes once. */
function useLivePullRequest(
  taskId: string,
  workspaceId: string,
  stored: PullRequestRef | null,
): PullRequestRef | null {
  const [pr, setPr] = useState<PullRequestRef | null>(stored);
  const has = stored !== null;
  useEffect(() => {
    setPr(stored);
    if (!has) return;
    let live = true;
    api()
      .invoke('tasks:prStatus', taskId, workspaceId)
      .then((p) => {
        if (live && p) setPr(p);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, workspaceId, has]);
  return pr;
}

function prLabel(pr: PullRequestRef): string {
  if (pr.isDraft && pr.status === 'active') return 'Draft';
  return pr.status.charAt(0).toUpperCase() + pr.status.slice(1);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** "pushed to origin" when the upstream is the same branch on a remote, else the upstream in full. */
function pushState(s: TaskSummary, branch: string): string {
  if (!s.upstream) return 'local only';
  const to = s.upstream.endsWith(`/${branch}`)
    ? s.upstream.slice(0, -branch.length - 1)
    : s.upstream;
  return s.pushed ? `pushed to ${to}` : `not all pushed to ${to}`;
}

/** The facts of one workspace: its branch and push state, pull request and changes. */
function WorkspaceFacts({ taskId, w }: { taskId: string; w: WorkspaceView }) {
  const notify = useStore((s) => s.notify);
  const pr = useLivePullRequest(taskId, w.id, w.pullRequest);
  const s = w.summary;
  return (
    <>
      <Fact label="Branch">
        <span className="mono">{w.branch}</span>
        {s && <span className="muted"> {pushState(s, w.branch)}</span>}
      </Fact>
      {pr && (
        <Fact label="Pull request">
          <button
            type="button"
            className="link"
            aria-label={`Open pull request ${pr.id} in Azure DevOps`}
            onClick={() =>
              tryInvoke(
                () => api().invoke('shell:openExternal', pr.url),
                notify,
              )
            }
          >
            {`PR ${pr.id} · ${prLabel(pr)}`}
          </button>
        </Fact>
      )}
      {s && s.baseKnown && (
        <Fact label="Changes">
          {s.filesChanged} {s.filesChanged === 1 ? 'file' : 'files'},{' '}
          <span className="text-green">+{s.insertions}</span>{' '}
          <span className="text-red">
            {MINUS}
            {s.deletions}
          </span>
        </Fact>
      )}
    </>
  );
}

/** The commits of one workspace, or why there is no summary. */
function WorkspaceCommits({ w }: { w: WorkspaceView }) {
  const s = w.summary;
  if (!s)
    return (
      <p className="done-nosummary muted">
        {w.baseSha
          ? 'No summary: git could not read the branch when it finished.'
          : 'Finished before Shellie recorded summaries.'}
      </p>
    );
  return (
    <section className="done-commits" aria-label="Commits">
      <h2>
        Commits {s.baseKnown && <span className="muted">{s.commitCount}</span>}
      </h2>
      {!s.baseKnown ? (
        <p className="muted">
          Commits unavailable: Shellie could not find where this branch started.
        </p>
      ) : s.commits.length === 0 ? (
        <p className="muted">No commits on this branch.</p>
      ) : (
        <ol>
          {s.commits.map((c) => (
            <li key={c.sha}>
              <span className="mono muted">{c.sha}</span>
              <span className="done-subject">{c.subject}</span>
            </li>
          ))}
        </ol>
      )}
      {s.commitCount > s.commits.length && (
        <p className="muted small">
          and {s.commitCount - s.commits.length} more
        </p>
      )}
    </section>
  );
}

/** The repo's name, or its worktree folder when the repo was removed from Shellie. */
function useRepoName(w: WorkspaceView): string {
  const repos = useStore((s) => s.repos);
  return (
    repos.find((r) => r.id === w.repoId)?.name ??
    w.worktreePath.split(/[\\/]/).filter(Boolean).pop() ??
    w.repoId
  );
}

function WorkspaceSection({ task, w }: { task: TaskView; w: WorkspaceView }) {
  const name = useRepoName(w);
  return (
    <section className="done-workspace" aria-label={name}>
      <h2>{name}</h2>
      <dl className="facts">
        <WorkspaceFacts taskId={task.id} w={w} />
      </dl>
      <WorkspaceCommits w={w} />
    </section>
  );
}

function DroppedNote({ w }: { w: WorkspaceView }) {
  const name = useRepoName(w);
  return <p className="muted done-dropped">{`${name}: no changes, removed`}</p>;
}

/**
 * Worktree folders Finish could not remove yet because a process still held files in them (#115). Shellie retries
 * in the background, so this is a quiet status, not an error.
 */
function PendingCleanupStatus({ task }: { task: TaskView }) {
  const notify = useStore((s) => s.notify);
  const [retrying, setRetrying] = useState(false);
  if (task.pendingCleanup.length === 0) return null;
  const retry = async () => {
    setRetrying(true);
    await tryInvoke(() => api().invoke('tasks:retryCleanup', task.id), notify);
    setRetrying(false);
  };
  const stuck = task.pendingCleanup.some((p) => p.notified);
  return (
    <div role="status" aria-label="Cleanup" className="done-cleanup">
      <div className={stuck ? 'text-warn' : 'muted'}>
        {stuck
          ? 'Still not removed after a day: a process still holds files in the worktree folder.'
          : 'Removing the worktree folder: a process still holds files in it. Shellie retries every few minutes.'}{' '}
        <button
          type="button"
          className="btn btn-sm"
          disabled={retrying}
          onClick={() => void retry()}
        >
          {retrying ? 'Retrying' : 'Retry now'}
        </button>
      </div>
      {task.pendingCleanup.map((p) => (
        <div key={p.worktreePath} className="small">
          <span className="mono">{p.worktreePath}</span>
          <span className="muted">{` · tried ${p.attempts}×, last: ${p.error}`}</span>
        </div>
      ))}
      <div className="muted small">
        What holds it: on Windows, Resource Monitor (resmon) › CPU › Associated
        Handles, search for the folder name; on macOS,{' '}
        <span className="mono">lsof +D &lt;folder&gt;</span>. Often a dev
        server, an editor or a dotnet build server (
        <span className="mono">dotnet build-server shutdown</span>).
      </div>
    </div>
  );
}

/** A finished task: what it was, how long it took, what it changed and pushed, what the AI cost, and its usage. */
export function DoneTaskPage({ task }: { task: TaskView }) {
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const select = useStore((s) => s.select);
  const openTask = useStore((s) => s.openTask);
  const [reopening, setReopening] = useState(false);
  const reopen = async () => {
    setReopening(true);
    const r = await tryInvoke(
      () => api().invoke('tasks:reopen', task.id),
      notify,
    );
    setReopening(false);
    if (!r) return;
    if (r.setup) {
      select(task.id);
      go({ kind: 'setup', taskId: task.id });
    } else openTask(task.id);
  };
  const connectionId = useTaskConnectionId(task);
  const usage = useTaskUsage(task.id);
  const { time } = useTaskTime(task.id);
  const booking = time?.booking ?? null;
  const [retrying, setRetrying] = useState(false);
  const retryTime = async () => {
    setRetrying(true);
    await tryInvoke(() => api().invoke('time:sync', task.id), notify);
    setRetrying(false);
  };
  const wi = task.workItem;
  const live = useLiveWorkItem(connectionId, wi?.id ?? null);
  const workspaces = taskWorkspaces(task);
  const noRepo = hasNoRepo(task);
  // Every repo the task had, dropped ones included: those show as "no changes, removed".
  const multi = workspaces.length > 1;
  const took = task.finishedAt
    ? duration(task.createdAt, task.finishedAt)
    : null;
  return (
    <div className="page page-done">
      <PageHeader
        before={
          wi && (
            <>
              <TaskTypeIcon task={task} size={20} />
              {wi.url ? (
                <button
                  type="button"
                  className="link pagehead-id"
                  aria-label={`Open ${wi.type} ${wi.id} in Azure DevOps`}
                  onClick={() =>
                    tryInvoke(
                      () => api().invoke('shell:openExternal', wi.url!),
                      notify,
                    )
                  }
                >
                  {wi.type} {wi.id}
                </button>
              ) : (
                <span className="pagehead-id">
                  {wi.type} {wi.id}
                </span>
              )}
            </>
          )
        }
        title={wi?.title ?? task.name}
        commands={
          // A task without a repo has no worktree or branch to come back to (#225).
          !noRepo && (
            <button
              type="button"
              className="btn"
              disabled={reopening}
              title="Back to work on this task: its worktree, terminals and Claude sessions"
              onClick={() => void reopen()}
            >
              <ArrowUndo16Regular aria-hidden="true" />
              {reopening ? 'Reopening' : 'Reopen'}
            </button>
          )
        }
        after={
          live &&
          wi && (
            <span className="pagehead-state" aria-label={`State ${live.state}`}>
              <StateDot
                state={live.state}
                type={live.type || wi.type}
                connectionId={connectionId}
              />
            </span>
          )
        }
      />
      <div className="done-body">
        <dl className="facts">
          <Fact label="Duration">{took ?? 'Unknown'}</Fact>
          <Fact label="Finished">
            {task.finishedAt ? dateTime(task.finishedAt) : 'Unknown'}
          </Fact>
          {noRepo ? (
            <Fact label="Repo">No repo</Fact>
          ) : (
            !multi && <WorkspaceFacts taskId={task.id} w={workspaces[0]} />
          )}
          {task.finishedEnvironment &&
            task.finishedEnvironment !== 'development' && (
              <Fact label="Environment">
                <span className={envTextClass(task.finishedEnvironment)}>
                  {ENVIRONMENT_LABEL[task.finishedEnvironment]}
                </span>
              </Fact>
            )}
          <Fact label="AI cost">
            {usage ? (
              <>
                {eur(usage.billable.costEur)}{' '}
                <span className="muted">
                  (Claude {eur(usage.byTool['claude-code'].costEur)}, Copilot{' '}
                  {eur(usage.byTool['copilot-cli'].costEur)}
                  {usage.byTool.opencode.costEur !== 0 &&
                    `, OpenCode ${eur(usage.byTool.opencode.costEur)}`}
                  )
                </span>
              </>
            ) : (
              '...'
            )}
          </Fact>
          <Fact label="Time booked">
            {booking ? (
              <>
                {`booked ${formatDuration(booking.bookedSeconds)} (measured ${formatDuration(booking.measuredSeconds)})`}
                {booking.syncError && (
                  <div className="text-warn small" role="status">
                    {`Not written to Azure DevOps: ${booking.syncError} `}
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={retrying}
                      onClick={() => void retryTime()}
                    >
                      Retry
                    </button>
                  </div>
                )}
              </>
            ) : (
              'Not booked'
            )}
          </Fact>
        </dl>
        <PendingCleanupStatus task={task} />
        {multi ? (
          <>
            {workspaces
              .filter((w) => !w.dropped)
              .map((w) => (
                <WorkspaceSection key={w.id} task={task} w={w} />
              ))}
            {workspaces
              .filter((w) => w.dropped)
              .map((w) => (
                <DroppedNote key={w.id} w={w} />
              ))}
          </>
        ) : (
          !noRepo && <WorkspaceCommits w={workspaces[0]} />
        )}
        <UsagePanel taskId={task.id} />
      </div>
    </div>
  );
}
