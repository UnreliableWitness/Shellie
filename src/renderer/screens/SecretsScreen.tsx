import {
  ChevronLeft16Regular,
  Shield16Filled,
  Warning16Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Environment,
  SecretScope,
  SecretView,
  SecretsStatus,
} from '../../shared/secrets';
import { api, tryInvoke } from '../api';
import { plural } from '../format';
import { SecretEditor } from '../components/secrets/SecretEditor';
import { GIVEN_LABEL, SecretRow } from '../components/secrets/SecretRow';
import { ConfirmBar, PageHeader } from '../components/ui';
import { ENVIRONMENTS, ENVIRONMENT_LABEL } from '../../shared/secrets';
import { useStore } from '../store';

type Editing =
  | { kind: 'new'; env?: Environment }
  | { kind: 'edit'; secret: SecretView; env?: Environment };

/** A repo's secrets status: the protected sentence, or a warning card per reason with its action. */
export function StatusPanel({
  repo,
  status,
  onClean,
}: {
  repo: { id: string; name: string };
  status: SecretsStatus | null;
  onClean: () => void;
}) {
  const go = useStore((s) => s.go);
  if (!status || status.state === 'empty') return null;
  if (status.state === 'protected')
    return (
      <div className="secret-panel secret-panel-ok">
        <Shield16Filled aria-hidden="true" />
        <div>
          <strong>{repo.name} is protected.</strong>{' '}
          {status.given.length > 0
            ? `${plural(status.secrets, 'secret reaches', 'secrets reach')} the ${status.given.map((g) => GIVEN_LABEL[g]).join(' and ')} tabs only. `
            : ''}
          Claude Code, Copilot and OpenCode tabs run without them, and their
          file tools are denied the secret files.
        </div>
      </div>
    );
  return (
    <>
      {status.reasons.map((r) => (
        <div key={r.kind} className="secret-panel secret-panel-warn">
          <Warning16Regular aria-hidden="true" />
          <div>
            {r.kind === 'copy' && (
              <>
                <strong>
                  {repo.name} still copies {r.files.join(', ')} into every
                  worktree
                </strong>{' '}
                (<code>copy:</code> in its .shellie.yml), where agents can read
                it.
              </>
            )}
            {r.kind === 'tracked' && (
              <>
                <strong>
                  Secrets are committed in{' '}
                  {plural(r.files.length, 'file', 'files')}
                </strong>{' '}
                — move them out of git. Shellie never edits tracked files.
                <ul>
                  {r.files.map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {r.kind === 'unchecked' && (
              <>
                <strong>
                  {`Shellie couldn't check ${repo.name} with git`}
                </strong>{' '}
                — the status may be incomplete.
              </>
            )}
            {r.kind === 'worktrees' && (
              <>
                <strong>
                  {plural(r.taskIds.length, 'open task', 'open tasks')} still{' '}
                  {r.taskIds.length === 1 ? 'has' : 'have'} the old copied file
                </strong>
                , with the secrets still in it.
              </>
            )}
          </div>
          {r.kind === 'copy' && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => go({ kind: 'secrets-import', repoId: repo.id })}
            >
              Move {plural(r.count, 'value', 'values')} into Shellie…
            </button>
          )}
          {r.kind === 'worktrees' && (
            <button type="button" className="btn btn-sm" onClick={onClean}>
              Clean {plural(r.taskIds.length, 'worktree', 'worktrees')}
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/** Settings > Secrets: what Shellie keeps for each repository, where it came from and which tabs get it. */
export function SecretsScreen({ repoId }: { repoId?: string }) {
  const repos = useStore((s) => s.repos);
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const [scope, setScope] = useState<string>(repoId ?? 'all');
  const [shown, setShown] = useState<SecretView[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<SecretView | null>(null);

  // Only the latest load applies: a slow answer for a scope left behind is dropped.
  const loadToken = useRef(0);
  const load = useCallback(async () => {
    const mine = ++loadToken.current;
    const latest = () => loadToken.current === mine;
    const lists = await tryInvoke(
      () =>
        Promise.all([
          api().invoke('secrets:list', scope),
          api().invoke('secrets:list', 'all'),
          ...repos.map((r) => api().invoke('secrets:list', r.id)),
        ]),
      notify,
    );
    if (!lists || !latest()) return;
    const [current, all, ...perRepo] = lists;
    setShown(current);
    const next: Record<string, number> = { all: all.length };
    repos.forEach((r, i) => {
      next[r.id] = (perRepo[i] ?? []).filter(
        (x) => typeof x.scope !== 'string' && x.scope.repoId === r.id,
      ).length;
    });
    setCounts(next);
    if (scope !== 'all') {
      const st = await tryInvoke(
        () => api().invoke('secrets:status', scope),
        notify,
      );
      if (latest()) setStatus(st ?? null);
    } else setStatus(null);
  }, [scope, repos, notify]);

  useEffect(() => {
    void load();
    return api().on('secrets:changed', () => void load());
  }, [load]);

  const repo = repos.find((r) => r.id === scope);
  const newScope: SecretScope = scope === 'all' ? 'all' : { repoId: scope };

  const move = async (secret: SecretView) => {
    const saved = await tryInvoke(
      () =>
        api().invoke('secrets:save', {
          id: secret.id,
          scope: 'all',
          name: secret.name,
          givenTo: secret.givenTo,
          values: {},
        }),
      notify,
    );
    if (saved) await load();
  };

  const clean = async () => {
    if (!repo) return;
    // Main sends secrets.worktreesCleaned.
    await tryInvoke(
      () => api().invoke('secrets:cleanWorktrees', repo.id),
      notify,
    );
    await load();
  };

  const remove = async () => {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    await tryInvoke(() => api().invoke('secrets:delete', id), notify);
    await load();
  };

  return (
    <div className="page">
      <PageHeader
        title="Secrets"
        before={
          <button
            type="button"
            className="btn btn-subtle btn-sm"
            onClick={() =>
              go(
                repo
                  ? {
                      kind: 'settings',
                      repoId: repo.id,
                      section: 'repo-secrets',
                    }
                  : { kind: 'settings', section: 'secrets' },
              )
            }
          >
            <ChevronLeft16Regular aria-hidden="true" /> Settings
          </button>
        }
        commands={
          <>
            <button
              type="button"
              className="btn"
              disabled={!repo}
              title={repo ? undefined : 'Pick a repository first'}
              onClick={() =>
                repo && go({ kind: 'secrets-import', repoId: repo.id })
              }
            >
              Import from .env…
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setEditing({ kind: 'new' })}
            >
              + Add secret
            </button>
          </>
        }
      />
      <p className="secrets-lede">
        Shellie keeps these encrypted on this machine and hands them only to the
        tabs that need them. Agent tabs never get them, and no worktree gets a
        .env file.
      </p>
      <div className="secrets">
        <nav className="secrets-scope" aria-label="Scope">
          <h2>Scope</h2>
          {[
            { id: 'all', name: 'All repositories' },
            ...repos.map((r) => ({ id: r.id, name: r.name })),
          ].map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={scope === s.id ? 'true' : undefined}
              onClick={() => {
                setScope(s.id);
                setShown(null);
                setStatus(null);
                setEditing(null);
              }}
            >
              <span>{s.name}</span>
              <span>{counts[s.id] ?? 0}</span>
            </button>
          ))}
        </nav>
        <div className="secrets-main">
          {repo && (
            <StatusPanel
              repo={repo}
              status={status}
              onClean={() => void clean()}
            />
          )}
          {editing && (
            <SecretEditor
              key={editing.kind === 'edit' ? editing.secret.id : 'new'}
              repos={repos}
              scope={newScope}
              initial={editing.kind === 'edit' ? editing.secret : undefined}
              focusEnv={editing.env}
              onDone={() => {
                setEditing(null);
                void load();
              }}
              onCancel={() => setEditing(null)}
            />
          )}
          {deleting && (
            <ConfirmBar
              message={`Delete ${deleting.name}? Its values are removed from this machine.`}
              confirmLabel="Delete secret"
              onConfirm={() => void remove()}
              onCancel={() => setDeleting(null)}
            />
          )}
          {shown && shown.length === 0 && !editing && (
            <p className="secrets-empty">
              No secrets here yet. Add one, or import the values from a .env
              file.
            </p>
          )}
          {shown && shown.length > 0 && (
            <table className="secrets-table">
              <thead>
                <tr>
                  <th>Name</th>
                  {ENVIRONMENTS.map((e) => (
                    <th key={e}>{ENVIRONMENT_LABEL[e]}</th>
                  ))}
                  <th>Given to</th>
                  <th>Changed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <SecretRow
                    key={s.id}
                    secret={s}
                    allRepos={s.scope === 'all' && scope !== 'all'}
                    onAdd={(env) =>
                      setEditing({ kind: 'edit', secret: s, env })
                    }
                    onEdit={() => setEditing({ kind: 'edit', secret: s })}
                    onMove={() => void move(s)}
                    onDelete={() => setDeleting(s)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
