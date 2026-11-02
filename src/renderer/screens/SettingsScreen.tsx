import { useEffect, useState } from 'react';
import type { AppSettings } from '../../shared/usage';
import type { ThemeChoice } from '../../shared/theme';
import type {
  AgentCommands,
  ShellieConfig,
  Repo,
  StartSettings,
  WorkItemTypeMeta,
} from '../../shared/types';
import { api, saveSettings, tryInvoke } from '../api';
import { ConnectionsSection } from '../components/ConnectionsSection';
import { CostSection } from '../components/CostSection';
import { EditorSection } from '../components/EditorSection';
import { AgentsSection } from '../components/AgentsSection';
import { TimeSection } from '../components/TimeSection';
import { BudgetSection } from '../components/BudgetSection';
import { CostServerSection } from '../components/CostServerSection';
import { MindMark, PageHeader } from '../components/ui';
import { useStore } from '../store';

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
    <div className="list-row" style={{ display: 'block' }}>
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
    <div className="list-row" style={{ display: 'block' }}>
      <details>
        <summary>Agent commands</summary>
        <div className="small muted" style={{ marginTop: 4 }}>
          Runs in your shell when a tab starts; empty means the default. Shellie
          adds its own flags after the Claude Code command (session, resume,
          extra folders, theme, task context), so enter only yours, e.g.{' '}
          <span className="mono">claude --permission-mode acceptEdits</span>.
        </div>
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
      </details>
    </div>
  );
}

function RepoRow({ repo }: { repo: Repo }) {
  const notify = useStore((s) => s.notify);
  const setRepos = useStore((s) => s.setRepos);
  const connections = useStore((s) => s.connections);
  const [shown, setShown] = useState<string | null>(null);

  const show = async () => {
    if (shown !== null) return setShown(null);
    const result = await tryInvoke(
      () => api().invoke('repos:config', repo.id),
      notify,
    );
    if (result)
      setShown(renderConfig(repo.name, result.config, result.worktreeRoot));
  };
  const remove = async () => {
    const ok = await tryInvoke(async () => {
      await api().invoke('repos:remove', repo.id);
      return true;
    }, notify);
    if (ok) setRepos(await api().invoke('repos:list'));
  };

  return (
    <>
      <div className="list-row">
        <div className="grow">
          <span style={{ fontWeight: 600 }}>{repo.name}</span>
          <span className="mono small muted">
            {repo.path} &middot; base {repo.baseBranch}
          </span>
        </div>
        {repo.discovered && (
          <>
            <span className="tag">Found in a task</span>
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
          </>
        )}
        {repo.configFound ? (
          <span className="tag tag-green">.shellie.yml found</span>
        ) : (
          <span className="tag tag-warn">No .shellie.yml, using defaults</span>
        )}
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
        <button type="button" className="btn btn-ghost btn-sm" onClick={show}>
          {shown === null ? 'Show setup' : 'Hide setup'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={remove}>
          Remove
        </button>
      </div>
      {repo.connectionId && <StartOptions repo={repo} />}
      <AgentCommandOptions repo={repo} />
      {shown !== null && (
        <div
          className="codeblock"
          style={{ borderRadius: 0, borderWidth: '0 0 1px 0' }}
        >
          {shown}
        </div>
      )}
    </>
  );
}

function AppearanceSection() {
  const notify = useStore((s) => s.notify);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    let live = true;
    void tryInvoke(() => api().invoke('settings:get'), notify).then((s) => {
      if (live && s) setSettings(s);
    });
    return () => {
      live = false;
    };
  }, [notify]);

  const toggle = async (
    patch: Partial<
      Pick<
        AppSettings,
        'showSplash' | 'sendTelemetry' | 'notifyOnDone' | 'theme'
      >
    >,
  ) => {
    if (!settings) return;
    const saved = await tryInvoke(() => saveSettings(patch), notify);
    if (saved) setSettings(saved);
  };

  return (
    <section id="appearance" className="section">
      <div className="section-head">
        <h2>Appearance</h2>
      </div>
      <div className="list">
        <div className="list-row">
          <label>
            Theme{' '}
            <select
              className="field"
              aria-label="Theme"
              value={settings?.theme ?? 'system'}
              disabled={!settings}
              onChange={(e) =>
                void toggle({ theme: e.target.value as ThemeChoice })
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
        <div className="list-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings?.showSplash ?? true}
              disabled={!settings}
              onChange={(e) => void toggle({ showSplash: e.target.checked })}
            />{' '}
            Show splash on start
          </label>
        </div>
        <div className="list-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings?.sendTelemetry ?? true}
              disabled={!settings}
              onChange={(e) => void toggle({ sendTelemetry: e.target.checked })}
            />{' '}
            Send anonymous usage and error data
          </label>
        </div>
        <div className="list-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings?.notifyOnDone ?? true}
              disabled={!settings}
              onChange={(e) => void toggle({ notifyOnDone: e.target.checked })}
            />{' '}
            Notify when an agent finishes its turn
          </label>
        </div>
      </div>
    </section>
  );
}

function AboutSection() {
  const [version, setVersion] = useState('');
  const go = useStore((s) => s.go);
  const notify = useStore((s) => s.notify);

  const getStarted = async () => {
    const saved = await tryInvoke(
      () =>
        saveSettings((f) => ({
          onboarding: { ...f.onboarding, dismissedAt: null },
        })),
      notify,
    );
    if (saved) go({ kind: 'get-started' });
  };

  useEffect(() => {
    let live = true;
    api()
      .invoke('app:info')
      .then((i) => {
        if (live) setVersion(i.version);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <section id="about" aria-label="About" className="section">
      <div className="section-head">
        <h2>About</h2>
      </div>
      <div className="card about">
        <MindMark size={40} />
        <div>
          <div className="about-name">Shellie</div>
          <div className="muted">
            Development tasks as isolated workspaces, with AI cost per task
          </div>
          <div className="small muted">
            General Systems Vehicle (accounting division)
          </div>
          {version && <div className="mono small muted">v{version}</div>}
          <button
            type="button"
            className="link"
            onClick={() => void getStarted()}
          >
            Get started
          </button>
        </div>
      </div>
    </section>
  );
}

export function SettingsScreen() {
  const repos = useStore((s) => s.repos);
  const go = useStore((s) => s.go);
  const notify = useStore((s) => s.notify);
  const section = useStore((s) =>
    s.screen.kind === 'settings' ? s.screen.section : undefined,
  );
  useEffect(() => {
    if (!section) return;
    const jump = () =>
      document.getElementById(section)?.scrollIntoView?.({ block: 'start' });
    jump();
    // Sections above the target load asynchronously and grow, so keep the
    // target in view while the layout settles, until the user takes over.
    const main = document.querySelector('.settings-main');
    let observer: ResizeObserver | undefined;
    if (main && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(jump);
      observer.observe(main);
      for (const child of Array.from(main.children)) observer.observe(child);
    }
    const stop = () => {
      observer?.disconnect();
      window.clearTimeout(timer);
      for (const ev of userEvents) window.removeEventListener(ev, stop, true);
    };
    const userEvents = ['wheel', 'pointerdown', 'keydown', 'touchstart'];
    for (const ev of userEvents) window.addEventListener(ev, stop, true);
    const timer = window.setTimeout(stop, 2000);
    return stop;
  }, [section]);

  const addFolder = async () => {
    const folder = await tryInvoke(
      () => api().invoke('repos:pickFolder'),
      notify,
    );
    if (!folder) return;
    go({ kind: 'add-repo', from: 'settings', folder });
  };

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <a href="#repos" className="active">
            Repositories
          </a>
          <a href="#editor">Editor</a>
          <a
            href="#secrets"
            onClick={(e) => {
              e.preventDefault();
              go({ kind: 'secrets' });
            }}
          >
            Secrets
          </a>
          <a href="#ado">Connections</a>
          <a href="#cost">AI cost and invoicing</a>
          <a href="#time">Time tracking</a>
          <a href="#budgets">Budgets</a>
          <a href="#cost-server">Cost server</a>
          <a href="#appearance">Appearance</a>
          <a href="#terminals">Agents and terminals</a>
        </nav>
        <main className="settings-main">
          <section id="repos" className="section">
            <div className="section-head">
              <h2>Repositories</h2>
              <button type="button" className="btn" onClick={addFolder}>
                Add folder&hellip;
              </button>
            </div>
            {repos.length === 0 ? (
              <div className="list">
                <div className="empty">
                  No repositories yet. Add the folder of a git repository to
                  start tasks in it.
                </div>
              </div>
            ) : (
              <div className="list">
                {repos.map((r) => (
                  <RepoRow key={r.id} repo={r} />
                ))}
              </div>
            )}
          </section>
          <EditorSection />
          <ConnectionsSection />
          <CostSection />
          <TimeSection />
          <BudgetSection />
          <CostServerSection />
          <AgentsSection />
          <AppearanceSection />
          <AboutSection />
        </main>
      </div>
    </div>
  );
}
