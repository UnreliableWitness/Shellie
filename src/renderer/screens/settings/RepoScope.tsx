import { useEffect, useState } from 'react';
import type {
  AgentCommands,
  Repo,
  ShellieConfig,
  StartSettings,
  WorkItemTypeMeta,
} from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../components/settings/SettingRow';
import { useStore } from '../../store';
import type { SettingsCategoryInfo } from './UserScope';

/** The Repository scope's categories, in tree order; Tasks 6-8 fill the ones without content yet. */
export const REPO_CATEGORIES: SettingsCategoryInfo[] = [
  { id: 'repo-secrets', title: 'Secrets & env', keywords: [] },
  { id: 'repo-general', title: 'General', keywords: [] },
  { id: 'repo-setup', title: 'Setup', keywords: [] },
  { id: 'repo-agents', title: 'Agents', keywords: [] },
  { id: 'repo-workitems', title: 'Work items on start', keywords: [] },
  { id: 'repo-danger', title: 'Remove repository', keywords: [] },
];

const title = (id: string) =>
  REPO_CATEGORIES.find((c) => c.id === id)?.title ?? id;

function renderConfig(
  name: string,
  c: ShellieConfig,
  worktreeRoot: string,
): string {
  const lines = [
    `${name}/.shellie.yml${c.found ? '' : ' (defaults, file not found)'}`,
    `base: ${c.base}`,
    `branch: "${c.branch}"`,
    `copy: [${c.copy.join(', ')}]`,
    'setup:',
    ...c.setup.map((s) => `  - ${s}`),
    'run:',
    ...Object.entries(c.run).map(([k, v]) => `  ${k}: ${v}`),
    ...(c.apm === undefined
      ? []
      : [`apm: ${c.apm === false ? 'false' : `[${c.apm.join(', ')}]`}`]),
    '',
    `# worktrees go in ${worktreeRoot}`,
  ];
  return lines.join('\n');
}

function StartOptions({ repo }: { repo: Repo }) {
  const notify = useStore((s) => s.notify);
  const [types, setTypes] = useState<WorkItemTypeMeta[] | null>(null);
  const settings = repo.workItemOnStart;
  const connectionId = repo.connectionId;

  // repos:changed is broadcast by the handler and refreshes the store.
  const save = (next: StartSettings) =>
    tryInvoke(
      () => api().invoke('repos:setWorkItemOnStart', repo.id, next),
      notify,
    );

  const loadTypes = async (open: boolean) => {
    if (!open || types !== null || !connectionId) return;
    const result = await tryInvoke(
      () => api().invoke('workItems:types', connectionId),
      notify,
    );
    if (result) setTypes(result);
  };

  const choose = (type: string, state: string) => {
    const { [type]: _removed, ...rest } = settings.stateOverrides;
    void save({
      ...settings,
      stateOverrides: state ? { ...rest, [type]: state } : rest,
    });
  };

  return (
    <div>
      <div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.moveToInProgress}
            onChange={(e) =>
              void save({ ...settings, moveToInProgress: e.target.checked })
            }
          />{' '}
          Move the work item to In Progress on start
        </label>
      </div>
      <div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.assignToMe}
            onChange={(e) =>
              void save({ ...settings, assignToMe: e.target.checked })
            }
          />{' '}
          Assign it to me if unassigned
        </label>
      </div>
      <details
        onToggle={(e) =>
          void loadTypes((e.currentTarget as HTMLDetailsElement).open)
        }
      >
        <summary>Override per type</summary>
        {types?.map((t) => (
          <div key={t.name} className="small" style={{ marginTop: 4 }}>
            <span>{t.name}</span>{' '}
            <select
              className="field"
              aria-label={`In Progress state for ${t.name}`}
              value={settings.stateOverrides[t.name] ?? ''}
              onChange={(e) => choose(t.name, e.target.value)}
            >
              <option value="">Default</option>
              {t.states
                .filter((s) => s.category === 'InProgress')
                .map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
            </select>
          </div>
        ))}
      </details>
    </div>
  );
}

const AGENT_COMMANDS = [
  { key: 'claude', label: 'Claude Code command' },
  { key: 'opencode', label: 'OpenCode command' },
] as const;

/** The repo's own start command for Claude Code and OpenCode tabs (#191), saved on leaving a field. */
function AgentCommandOptions({ repo }: { repo: Repo }) {
  const notify = useStore((s) => s.notify);
  const saved = repo.agentCommands;
  const [draft, setDraft] = useState<AgentCommands>(saved ?? {});

  useEffect(() => setDraft(saved ?? {}), [saved]);

  // repos:changed is broadcast by the handler and refreshes the store.
  const save = (key: keyof AgentCommands) => {
    if ((draft[key] ?? '') === (saved?.[key] ?? '')) return;
    void tryInvoke(
      () =>
        api().invoke('repos:setAgentCommands', repo.id, {
          ...saved,
          [key]: draft[key] ?? '',
        }),
      notify,
    );
  };

  return (
    <div>
      {AGENT_COMMANDS.map(({ key, label }) => (
        <div key={key} className="small" style={{ marginTop: 4 }}>
          <label>
            {label}{' '}
            <input
              className="field mono"
              aria-label={`${label} for ${repo.name}`}
              placeholder={key}
              value={draft[key] ?? ''}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              onBlur={() => save(key)}
            />
          </label>
        </div>
      ))}
    </div>
  );
}

/** The effective setup, read when the scope is shown (Task 6 turns it into rows). */
function EffectiveSetup({ repo, active }: { repo: Repo; active: boolean }) {
  const notify = useStore((s) => s.notify);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void tryInvoke(() => api().invoke('repos:config', repo.id), notify).then(
      (result) => {
        if (live && result)
          setShown(renderConfig(repo.name, result.config, result.worktreeRoot));
      },
    );
    return () => {
      live = false;
    };
  }, [active, repo, notify]);
  return shown === null ? (
    <div className="muted small">Loading&hellip;</div>
  ) : (
    <div className="codeblock">{shown}</div>
  );
}

/** One repo's settings. `active` is false while the scope is mounted hidden (for search counts). */
export function RepoScope({ repo, active }: { repo: Repo; active: boolean }) {
  const notify = useStore((s) => s.notify);
  const setRepos = useStore((s) => s.setRepos);
  const connections = useStore((s) => s.connections);
  const go = useStore((s) => s.go);

  const remove = async () => {
    const ok = await tryInvoke(async () => {
      await api().invoke('repos:remove', repo.id);
      return true;
    }, notify);
    if (ok) setRepos(await api().invoke('repos:list'));
  };

  return (
    <>
      <div className="settings-repo-head">
        <span style={{ fontWeight: 600 }}>{repo.name}</span>{' '}
        <span className="mono small muted">
          {repo.path} &middot; base {repo.baseBranch}
        </span>{' '}
        {repo.configFound ? (
          <span className="tag tag-green">.shellie.yml found</span>
        ) : (
          <span className="tag tag-warn">No .shellie.yml, using defaults</span>
        )}
      </div>
      <SettingsCategory id="repo-secrets" title={title('repo-secrets')}>
        <SettingRow
          id="repo-secrets-manage"
          scope="repo"
          category="Secrets & env"
          title="Secrets"
          description="Values Shellie puts in this repo's env files and terminals, per environment."
          keywords={['env', 'environment', 'import']}
        >
          <button
            type="button"
            className="btn"
            onClick={() => go({ kind: 'secrets', repoId: repo.id })}
          >
            Manage secrets&hellip;
          </button>
        </SettingRow>
      </SettingsCategory>
      <SettingsCategory id="repo-general" title={title('repo-general')}>
        <SettingRow
          id="repo-general-connection"
          scope="repo"
          category="General"
          title="Connection"
          description="The Azure DevOps project this repo's work items come from."
          keywords={['Azure DevOps', 'project']}
        >
          <select
            className="field"
            aria-label={`Connection for ${repo.name}`}
            value={repo.connectionId ?? ''}
            onChange={async (e) => {
              const value = e.target.value || null;
              // repos:changed is broadcast by the handler and updates the store.
              await tryInvoke(
                () => api().invoke('repos:setConnection', repo.id, value),
                notify,
              );
            }}
          >
            <option value="">No connection</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} / {c.project}
              </option>
            ))}
          </select>
        </SettingRow>
        {repo.discovered && (
          <SettingRow
            id="repo-general-discovered"
            scope="repo"
            category="General"
            title="Found in a task"
            description="Shellie registered this repo because a task worked in it; Start never picks it."
            keywords={['discovered']}
          >
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                tryInvoke(
                  () => api().invoke('repos:setDiscovered', repo.id, false),
                  notify,
                )
              }
            >
              Make it a normal repo
            </button>
          </SettingRow>
        )}
      </SettingsCategory>
      <SettingsCategory id="repo-setup" title={title('repo-setup')}>
        <SettingRow
          id="repo-setup-effective"
          scope="repo"
          category="Setup"
          title="Effective setup"
          description="What a new task in this repo uses: .shellie.yml with your overrides."
          keywords={[
            'base',
            'branch',
            'copy',
            'setup commands',
            'run',
            'apm',
            'worktrees',
          ]}
        >
          <EffectiveSetup repo={repo} active={active} />
        </SettingRow>
      </SettingsCategory>
      <SettingsCategory id="repo-agents" title={title('repo-agents')}>
        <SettingRow
          id="repo-agents-commands"
          scope="repo"
          category="Agents"
          title="Agent commands"
          description={
            <>
              Runs in your shell when a tab starts; empty means the default.
              Shellie adds its own flags after the Claude Code command (session,
              resume, extra folders, theme, task context), so enter only yours,
              e.g.{' '}
              <span className="mono">claude --permission-mode acceptEdits</span>
              .
            </>
          }
          keywords={[
            'Claude Code command',
            'OpenCode command',
            'shell',
            'flags',
            'permission mode',
            'default',
          ]}
        >
          <AgentCommandOptions repo={repo} />
        </SettingRow>
      </SettingsCategory>
      <SettingsCategory id="repo-workitems" title={title('repo-workitems')}>
        <SettingRow
          id="repo-workitems-start"
          scope="repo"
          category="Work items on start"
          title="Update the work item"
          description="What Start does to the work item: move it to In Progress and assign it to you."
          keywords={[
            'Move the work item to In Progress on start',
            'Assign it to me if unassigned',
            'state',
            'type',
          ]}
        >
          {repo.connectionId ? (
            <StartOptions repo={repo} />
          ) : (
            <div className="muted small">
              Choose a connection under General to change work items on start.
            </div>
          )}
        </SettingRow>
      </SettingsCategory>
      <SettingsCategory id="repo-danger" title={title('repo-danger')}>
        <SettingRow
          id="repo-danger-remove"
          scope="repo"
          category="Remove repository"
          title="Remove from Shellie"
          description="Shellie forgets this repo; the folder and its files stay."
          keywords={['delete']}
        >
          <button type="button" className="btn" onClick={remove}>
            Remove repository
          </button>
        </SettingRow>
      </SettingsCategory>
    </>
  );
}
