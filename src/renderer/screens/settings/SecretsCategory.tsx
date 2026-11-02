import { useCallback, useEffect, useState } from 'react';
import type { SecretsReason, SecretsStatus } from '../../../shared/secrets';
import { api } from '../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../components/settings/SettingRow';
import { useStore } from '../../store';

export const SECRETS_KEYWORDS = [
  'secret',
  'env',
  '.env',
  'environment',
  'password',
  'key',
  'token',
];

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const STATE: Record<SecretsStatus['state'], { label: string; tag: string }> = {
  protected: { label: 'Protected', tag: 'tag-green' },
  attention: { label: 'Needs attention', tag: 'tag-warn' },
  empty: { label: 'Nothing stored', tag: 'tag-muted' },
};

/** A status reason in one line, without the repo's name (the row has it). */
export function reasonLine(r: SecretsReason): string {
  switch (r.kind) {
    case 'copy':
      return `Copies ${r.files.join(', ')} into every worktree`;
    case 'tracked':
      return `Secrets are committed in ${plural(r.files.length, 'file', 'files')}`;
    case 'worktrees':
      return `${plural(r.taskIds.length, 'open task', 'open tasks')} still ${r.taskIds.length === 1 ? 'has' : 'have'} the old copied file`;
    case 'unchecked':
      return "Couldn't check with git";
  }
}

/** User › Secrets: each repository's secrets status, with the way into the manager and the import. */
export function SecretsCategory() {
  const allRepos = useStore((s) => s.repos);
  const go = useStore((s) => s.go);
  const repos = allRepos.filter((r) => !r.discovered);
  const ids = repos.map((r) => r.id).join('\u0000');
  /** Per repo: its status, or null when it could not be checked (shown on the row, never as a notice). */
  const [statuses, setStatuses] = useState<
    Record<string, SecretsStatus | null>
  >({});

  const load = useCallback(async () => {
    const list = ids ? ids.split('\u0000') : [];
    const results = await Promise.allSettled(
      list.map((id) => api().invoke('secrets:status', id)),
    );
    setStatuses(
      Object.fromEntries(
        list.map((id, i) => {
          const r = results[i];
          return [id, r.status === 'fulfilled' ? r.value : null];
        }),
      ),
    );
  }, [ids]);

  useEffect(() => {
    void load();
    const offSecrets = api().on('secrets:changed', () => void load());
    const offRepos = api().on('repos:changed', () => void load());
    return () => {
      offSecrets();
      offRepos();
    };
  }, [load]);

  return (
    <SettingsCategory
      id="secrets"
      title="Secrets"
      commands={
        <button
          type="button"
          className="btn"
          onClick={() => go({ kind: 'secrets' })}
        >
          Open secrets manager
        </button>
      }
    >
      {repos.length === 0 && (
        <SettingRow
          id="secrets-none"
          category="Secrets"
          title="Secrets manager"
          description="Values Shellie keeps encrypted on this machine and hands only to the tabs that need them."
          keywords={SECRETS_KEYWORDS}
        >
          <span className="muted">Add a repository to store its secrets.</span>
        </SettingRow>
      )}
      {repos.map((repo) => {
        const status = statuses[repo.id];
        const first = status?.reasons[0];
        const canImport =
          status != null &&
          (status.state === 'empty' ||
            status.reasons.some((r) => r.kind === 'copy'));
        return (
          <SettingRow
            key={repo.id}
            id={`secrets-repo-${repo.id}`}
            category="Secrets"
            title={repo.name}
            description={first ? reasonLine(first) : undefined}
            keywords={SECRETS_KEYWORDS}
          >
            <div className="settings-secrets-row">
              {status === null ? (
                <span className="text-warn">{"Couldn't check"}</span>
              ) : status ? (
                <>
                  <span className={`tag ${STATE[status.state].tag}`}>
                    {STATE[status.state].label}
                  </span>
                  <span className="muted">
                    {plural(status.secrets, 'secret', 'secrets')}
                  </span>
                </>
              ) : (
                <span className="muted">Checking&hellip;</span>
              )}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => go({ kind: 'secrets', repoId: repo.id })}
              >
                Manage
              </button>
              {canImport && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    go({ kind: 'secrets-import', repoId: repo.id })
                  }
                >
                  Import&hellip;
                </button>
              )}
            </div>
          </SettingRow>
        );
      })}
    </SettingsCategory>
  );
}
