import { useEffect, useState } from 'react';
import type { DiscardChecks, TaskView } from '../../shared/types';
import { api, tryInvoke } from '../api';
import { hasNoRepo } from '../../shared/workspaces';
import { plural } from '../format';
import { useStore } from '../store';
import { ConfirmBar } from './ui';

/**
 * The in-page confirm of Discard task (#124), on top of the task's page: what goes (folders, branches,
 * terminals, the task itself), what is lost (commits no remote has, uncommitted files) and what does not happen.
 */
export function DiscardBar({ task }: { task: TaskView }) {
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const cancelDiscard = useStore((s) => s.cancelDiscard);
  const [checks, setChecks] = useState<DiscardChecks | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadChecks = (live: () => boolean) =>
    api()
      .invoke('tasks:discardChecks', task.id)
      .then((c) => live() && setChecks(c))
      .catch(() => live() && setFailed(true));

  useEffect(() => {
    let live = true;
    void loadChecks(() => live);
    return () => {
      live = false;
    };
    // loadChecks only closes over task.id, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const name = task.workItem
    ? `${task.workItem.id} ${task.workItem.title}`
    : task.name;
  const lost = checks
    ? [
        checks.commitsLost > 0 &&
          plural(checks.commitsLost, 'commit') + ' on no remote',
        checks.uncommitted > 0 &&
          plural(checks.uncommitted, 'uncommitted file'),
      ].filter((x): x is string => Boolean(x))
    : [];
  const multi = (checks?.workspaces.length ?? 0) > 1;

  const discard = async () => {
    setBusy(true);
    const ok = await tryInvoke(async () => {
      // What the bar warned of is confirmed by its Discard anyway; main refuses anything else (#244).
      await api().invoke('tasks:discard', task.id, lost.length > 0);
      return true;
    }, notify);
    setBusy(false);
    // A refusal for work done since the bar opened: show that work, so Discard anyway can follow.
    if (!ok) return void loadChecks(() => true);
    cancelDiscard();
    go({ kind: 'home' });
    notify('info', `Discarded ${name}`);
  };

  const details = (
    <>
      {!checks && !failed && (
        <span className="confirm-bar-line muted">
          Checking what would be lost…
        </span>
      )}
      {checks && hasNoRepo(task) && (
        <span className="confirm-bar-line">
          Deletes the folder <code>{task.worktreePath}</code>.
        </span>
      )}
      {checks?.workspaces.map((w) => (
        <span key={w.workspaceId} className="confirm-bar-line">
          {multi && !w.kept && `${w.repoName}: `}
          {w.kept ? (
            <>
              {w.repoName} stays as it is (on {w.branch}, not the task&apos;s
              branch).
            </>
          ) : w.missing ? (
            <>
              {multi ? 'deletes' : 'Deletes'} the branch <code>{w.branch}</code>{' '}
              (its folder is gone already).
            </>
          ) : (
            <>
              {multi ? 'deletes' : 'Deletes'} the folder{' '}
              <code>{w.worktreePath}</code> and the branch{' '}
              <code>{w.branch}</code>.
            </>
          )}
        </span>
      ))}
      {checks && checks.runningTerminals > 0 && (
        <span className="confirm-bar-line">
          Closes its {plural(checks.runningTerminals, 'terminal')}.
        </span>
      )}
      {lost.length > 0 && (
        <span className="confirm-bar-line confirm-bar-warn" role="status">
          {lost.join(' and ')} will be lost.
        </span>
      )}
      <span className="confirm-bar-line">
        The task will not appear under Done. Nothing is pushed, no time is
        booked, no pull request is made and the work item is not changed. The AI
        cost stays recorded, since it was spent.
      </span>
    </>
  );

  return (
    <ConfirmBar
      message={`Discard ${name}?`}
      details={details}
      confirmLabel={lost.length > 0 ? 'Discard anyway' : 'Discard task'}
      busy={busy}
      confirmDisabled={!checks && !failed}
      onConfirm={() => void discard()}
      onCancel={cancelDiscard}
    />
  );
}
