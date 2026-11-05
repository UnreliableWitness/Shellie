import {
  CheckmarkCircle16Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  ErrorCircle16Regular,
  LockClosed16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { type ReactNode, useState } from 'react';
import type {
  CopyEntry,
  CopyEntryState,
  SetupSummary,
} from '../../shared/types';
import { useStore } from '../store';

const STATE_ICON: Record<CopyEntryState, { icon: ReactNode; label: string }> = {
  present: {
    icon: <CheckmarkCircle16Regular className="text-green" />,
    label: 'Present',
  },
  missing: {
    icon: <Warning16Regular className="text-warn" />,
    label: 'Missing',
  },
  holdsSecrets: {
    icon: <LockClosed16Regular />,
    label: 'Holds secrets',
  },
  notIgnored: {
    icon: <ErrorCircle16Regular className="text-red" />,
    label: 'Not ignored by git',
  },
  outside: {
    icon: <ErrorCircle16Regular className="text-red" />,
    label: 'Outside the repository',
  },
};

/** The copy states that make a warning line under Env. */
const WARNING: Partial<Record<CopyEntryState, string>> = {
  missing: 'is missing in the main checkout',
  notIgnored: 'is not ignored by git',
  outside: 'is outside the repository',
};

const list = (items: string[], none: string) =>
  items.length > 0 ? items.join(', ') : none;

function workItemText(w: SetupSummary['workItem']): string {
  if (!w) return 'No work item';
  const parts = [
    ...(w.move ? [`Move to ${w.move}`] : []),
    ...(w.assign ? [w.move ? 'assign to me' : 'Assign to me'] : []),
  ];
  const text = parts.length > 0 ? parts.join(', ') : 'Unchanged';
  return w.source ? `${text} (${w.source})` : text;
}

function setupText(s: SetupSummary): string {
  const apm =
    s.apm === false
      ? ['no agent packages']
      : s.apm && s.apm.length > 0
        ? [`apm install for ${s.apm.join(', ')}`]
        : [];
  return list([...s.commands, ...apm], 'Nothing to run');
}

/** "This task will…": what a task gets, each line with an Edit link to the setting it comes from. */
export function TaskSummaryCard({
  summary,
  repoId,
  copyStates,
  collapsible = false,
}: {
  summary: SetupSummary;
  repoId: string;
  copyStates?: CopyEntry[];
  collapsible?: boolean;
}) {
  const go = useStore((s) => s.go);
  const connectionId = useStore(
    (s) => s.repos.find((r) => r.id === repoId)?.connectionId ?? null,
  );
  const [open, setOpen] = useState(false);
  const shown = !collapsible || open;

  /** An Edit link to a setting of the repo, of the user, or of the repo's project. */
  const edit = (
    name: string,
    section: string,
    scope: 'repo' | 'user' | 'project' = 'repo',
  ) => (
    <button
      type="button"
      className="link small"
      aria-label={`Edit ${name}`}
      onClick={() =>
        go(
          scope === 'user'
            ? { kind: 'settings', section }
            : scope === 'project'
              ? {
                  kind: 'settings',
                  scope: 'project',
                  ...(connectionId ? { connectionId } : {}),
                  section,
                }
              : { kind: 'settings', repoId, section },
        )
      }
    >
      Edit
    </button>
  );

  const row = (name: string, body: ReactNode, editLink: ReactNode) => (
    <li className="task-summary-row">
      <span className="task-summary-label muted">{name}</span>
      <div className="task-summary-value">{body}</div>
      {editLink}
    </li>
  );

  const stateOf = (p: string) => copyStates?.find((e) => e.path === p)?.state;
  const warnings = summary.copy.flatMap((p) => {
    const state = stateOf(p);
    const text = state ? WARNING[state] : undefined;
    return text ? [{ path: p, text }] : [];
  });

  const heading = 'This task will…';
  return (
    <section className="task-summary" aria-label={heading}>
      {collapsible ? (
        <button
          type="button"
          className="task-summary-head task-summary-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? (
            <ChevronDown16Regular aria-hidden="true" />
          ) : (
            <ChevronRight16Regular aria-hidden="true" />
          )}
          {heading}
        </button>
      ) : (
        <div className="task-summary-head">{heading}</div>
      )}
      {shown && (
        <ul className="task-summary-list">
          {row(
            'Branch',
            <span>
              <span className="mono small">{summary.branch}</span> from{' '}
              <span className="mono small">{summary.base}</span>
            </span>,
            edit('Branch', 'repo-general'),
          )}
          {row(
            'Env',
            <>
              {summary.copy.length === 0 ? (
                <span>Nothing copied</span>
              ) : (
                <span className="task-summary-files">
                  {summary.copy.map((p) => {
                    const state = stateOf(p);
                    return (
                      <span key={p} className="task-summary-file">
                        {state && (
                          <span
                            className="task-summary-icon"
                            role="img"
                            aria-label={STATE_ICON[state].label}
                          >
                            {STATE_ICON[state].icon}
                          </span>
                        )}
                        <span className="mono small">{p}</span>
                      </span>
                    );
                  })}
                </span>
              )}
              {warnings.map((w) => (
                <div
                  key={w.path}
                  role="alert"
                  className="task-summary-warn text-warn small"
                >
                  <Warning16Regular aria-hidden="true" />
                  <span>
                    <span className="mono">{w.path}</span> {w.text}
                  </span>
                </div>
              ))}
            </>,
            edit('Env', 'repo-secrets'),
          )}
          {row(
            'Setup',
            <span>{setupText(summary)}</span>,
            edit('Setup', 'repo-setup'),
          )}
          {row(
            'Opens',
            <span>{list(summary.tabs, 'No tabs')}</span>,
            edit('Opens', 'terminals', 'user'),
          )}
          {row(
            'Run',
            <span>{list(summary.run, 'No run commands')}</span>,
            edit('Run', 'repo-run'),
          )}
          {row(
            'Work item',
            <span>{workItemText(summary.workItem)}</span>,
            edit('Work item', 'repo-workitems'),
          )}
          {row(
            'Brain',
            <span>{summary.brain ?? 'None for this project'}</span>,
            edit('Brain', 'project-brains', 'project'),
          )}
          {row(
            'Editor',
            <span>{summary.editor ?? 'Chosen by Shellie'}</span>,
            edit('Editor', 'repo-editor'),
          )}
        </ul>
      )}
    </section>
  );
}
