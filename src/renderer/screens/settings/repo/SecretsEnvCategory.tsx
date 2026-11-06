import { Add16Regular } from '@fluentui/react-icons';
import { useCallback, useEffect, useState } from 'react';
import {
  ENVIRONMENTS,
  ENVIRONMENT_LABEL,
  type Environment,
  isGuarded,
  type SecretsStatus,
} from '../../../../shared/secrets';
import type { CopyEntry, CopyEntryState, Repo } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import { plural } from '../../../format';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { PopupMenu } from '../../../components/ui/PopupMenu';
import { useStore } from '../../../store';
import { StatusPanel } from '../../SecretsScreen';
import { SECRETS_KEYWORDS } from '../SecretsCategory';
import { Loading } from './GeneralCategory';
import { type RepoSettings, yamlRow } from './useRepoSettings';

/** A repo can default to Development or Test only. */
const DEFAULT_CHOICES = ENVIRONMENTS.filter((e) => !isGuarded(e));

const STATE: Record<CopyEntryState, { label: string; tag: string }> = {
  present: { label: 'Present', tag: 'tag-green' },
  missing: { label: 'Missing', tag: 'tag-warn' },
  holdsSecrets: { label: 'Holds secrets', tag: 'tag-warn' },
  notIgnored: { label: 'Not ignored by git', tag: 'tag-red' },
  outside: { label: 'Outside the repository', tag: 'tag-red' },
};

/** Repository › Secrets & env: the secrets status, the default environment and the files copied into worktrees. */
export function SecretsEnvCategory({
  repo,
  settings,
  active,
  title,
}: {
  repo: Repo;
  settings: RepoSettings;
  active: boolean;
  title: string;
}) {
  const go = useStore((s) => s.go);
  const notify = useStore((s) => s.notify);
  const [status, setStatus] = useState<SecretsStatus | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [copy, setCopy] = useState<{
    entries: CopyEntry[];
    suggestions: string[];
  } | null>(null);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [adding, setAdding] = useState(false);

  const loadSecrets = useCallback(async () => {
    const result = await tryInvoke(
      () =>
        Promise.all([
          api().invoke('secrets:status', repo.id),
          api().invoke('secrets:repoDefault', repo.id),
        ]),
      notify,
    );
    if (result) {
      setStatus(result[0]);
      setEnv(result[1]);
    }
  }, [repo.id, notify]);

  const loadCopy = useCallback(async () => {
    const result = await tryInvoke(
      () => api().invoke('repos:copyEntries', repo.id),
      notify,
    );
    if (result) setCopy(result);
  }, [repo.id, notify]);

  // The list changes with the effective copy list too (an override saved here).
  const copyKey = settings.config?.copy.join('\u0000');
  useEffect(() => {
    if (!active) return;
    void loadSecrets();
    void loadCopy();
    const offSecrets = api().on('secrets:changed', () => {
      void loadSecrets();
      void loadCopy();
    });
    const offRepos = api().on('repos:changed', () => {
      void loadSecrets();
      void loadCopy();
    });
    return () => {
      offSecrets();
      offRepos();
    };
  }, [active, loadSecrets, loadCopy, copyKey]);

  const list = settings.config?.copy ?? [];
  const setCopyList = (next: string[]) => void settings.set('copy', next);
  const add = (rel: string) => {
    if (!list.includes(rel)) setCopyList([...list, rel]);
  };
  const choose = async () => {
    const rel = await tryInvoke(
      () => api().invoke('repos:pickFile', repo.id),
      notify,
    );
    if (rel) add(rel);
  };
  const clean = async () => {
    await tryInvoke(
      () => api().invoke('secrets:cleanWorktrees', repo.id),
      notify,
    );
    await loadSecrets();
  };
  const changeDefault = async (next: Environment) => {
    const previous = env;
    setEnv(next);
    const saved = await tryInvoke(
      () =>
        api()
          .invoke('secrets:setRepoDefault', repo.id, next)
          .then(() => true),
      notify,
    );
    // A failed save puts the select back on what is stored.
    if (!saved) setEnv(previous);
  };
  const suggestions = (copy?.suggestions ?? []).filter(
    (s) => !list.includes(s),
  );

  return (
    <SettingsCategory id="repo-secrets" title={title}>
      <SettingRow
        id="repo-secrets-manage"
        scope="repo"
        category="Secrets & env"
        title="Secrets"
        description="Values Shellie keeps encrypted on this machine and puts in this repo's env files and terminals, per environment. Agent tabs never get them."
        keywords={[...SECRETS_KEYWORDS, 'import', 'protected']}
      >
        <StatusPanel repo={repo} status={status} onClean={() => void clean()} />
        <div className="settings-secrets-row">
          <span>
            {status
              ? `${plural(status.secrets, 'secret', 'secrets')} stored`
              : 'Checking…'}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => go({ kind: 'secrets', repoId: repo.id })}
          >
            Manage secrets
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => go({ kind: 'secrets-import', repoId: repo.id })}
          >
            Import&hellip;
          </button>
        </div>
      </SettingRow>
      <SettingRow
        id="repo-secrets-environment"
        scope="repo"
        category="Secrets & env"
        title="Default environment"
        description="The environment a new task of this repo starts in. UAT and Production are chosen per task."
        keywords={['environment', 'development', 'test', 'secrets']}
      >
        <select
          className="field"
          aria-label="Default environment"
          value={env ?? ''}
          disabled={env === null}
          onChange={(e) => void changeDefault(e.target.value as Environment)}
        >
          {env === null && <option value="" />}
          {DEFAULT_CHOICES.map((e) => (
            <option key={e} value={e}>
              {ENVIRONMENT_LABEL[e]}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        id="repo-secrets-copy"
        scope="repo"
        category="Secrets & env"
        title="Files copied into each worktree"
        description="Git-ignored files (such as .env) that setup copies from the main checkout into every new worktree, without the values Shellie keeps."
        keywords={['copy', '.env', 'env', 'appsettings', 'local', 'worktree']}
        {...yamlRow(settings, 'copy')}
      >
        {!settings.config ? (
          <Loading />
        ) : (
          <>
            <ul
              className="settings-copy-list"
              aria-label="Files copied into each worktree"
            >
              {(copy?.entries ?? []).map((e) => (
                <li key={e.path}>
                  <span className="mono">{e.path}</span>
                  <span className={`tag ${STATE[e.state].tag}`}>
                    {STATE[e.state].label}
                  </span>
                  {e.state === 'holdsSecrets' && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => go({ kind: 'secrets', repoId: repo.id })}
                    >
                      Manage
                    </button>
                  )}
                  <span className="settings-copy-actions">
                    <button
                      type="button"
                      className="btn btn-subtle btn-sm"
                      aria-label={`Reveal ${e.path}`}
                      disabled={e.state === 'missing' || e.state === 'outside'}
                      onClick={() =>
                        void tryInvoke(
                          () => api().invoke('repos:reveal', repo.id, e.path),
                          notify,
                        )
                      }
                    >
                      Reveal
                    </button>
                    <button
                      type="button"
                      className="btn btn-subtle btn-sm"
                      aria-label={`Remove ${e.path}`}
                      onClick={() =>
                        setCopyList(list.filter((p) => p !== e.path))
                      }
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {copy && copy.entries.length === 0 && (
              <div className="muted">No files are copied.</div>
            )}
            <span ref={setAddAnchor}>
              <button
                type="button"
                className="btn btn-subtle"
                aria-haspopup="menu"
                aria-expanded={adding}
                onClick={() => setAdding((o) => !o)}
              >
                <Add16Regular /> Add file&hellip;
              </button>
            </span>
            <PopupMenu
              label="Add a file to copy"
              anchor={addAnchor}
              open={adding}
              align="start"
              onClose={() => setAdding(false)}
            >
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="menu-item mono"
                  onClick={() => {
                    setAdding(false);
                    add(s);
                  }}
                >
                  {s}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="menu-item"
                onClick={() => {
                  setAdding(false);
                  void choose();
                }}
              >
                Choose a file&hellip;
              </button>
            </PopupMenu>
          </>
        )}
      </SettingRow>
      <SettingRow
        id="repo-secrets-agent-config"
        scope="repo"
        category="Secrets & env"
        title="Copy agent config"
        description="Copy untracked agent config (opencode.json, .mcp.json and the like) into new worktrees."
        keywords={['copyAgentConfig', 'mcp', 'opencode', 'agent']}
        {...yamlRow(settings, 'copyAgentConfig')}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            disabled={!settings.config}
            checked={settings.config?.copyAgentConfig ?? true}
            onChange={(e) =>
              void settings.set('copyAgentConfig', e.target.checked)
            }
          />{' '}
          Copy agent config
        </label>
      </SettingRow>
    </SettingsCategory>
  );
}
