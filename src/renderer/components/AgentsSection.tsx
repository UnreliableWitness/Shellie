import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AGENT_IDS,
  AGENT_LABELS,
  INSTALL_COMMANDS,
  type AgentId,
  type AgentsDetected,
} from '../../shared/agents';
import type { DefaultTerminals } from '../../shared/terminals';
import { type AppSettings, defaultSettings } from '../../shared/usage';
import { pretick } from '../agentsPretick';
import { api, saveSettings, tryInvoke } from '../api';
import { useStore } from '../store';
import { SettingRow, SettingsCategory } from './settings/SettingRow';

const DOTS: Record<AgentId, string> = {
  claude: 'var(--chart-claude)',
  copilot: 'var(--chart-copilot)',
  opencode: 'var(--chart-opencode)',
};

const COST: Record<AgentId, string> = {
  claude: 'Per task, via OpenTelemetry',
  copilot: 'Per task, via its log',
  opencode: 'Per task, from its database',
};

/** Settings, and the body of the Agents step: what is installed and which tabs a new task opens. */
export function AgentsSection({ embedded }: { embedded?: boolean }) {
  const notify = useStore((s) => s.notify);
  const [tabs, setTabs] = useState<DefaultTerminals | null>(null);
  const [detected, setDetected] = useState<AgentsDetected | null>(null);
  const [checking, setChecking] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const [s, d] = await Promise.all([
        tryInvoke(() => api().invoke('settings:get'), notify),
        tryInvoke(() => api().invoke('agents:detect', false), notify),
      ]);
      if (!s) return;
      if (d) setDetected(d);
      if (d && s.onboarding.agentsCheckedAt === null) {
        const ticks = pretick(d);
        setTabs(ticks);
        await tryInvoke(
          () =>
            saveSettings({
              defaultTerminals: ticks,
              onboarding: {
                ...s.onboarding,
                agentsCheckedAt: new Date().toISOString(),
              },
            } satisfies Partial<AppSettings>),
          notify,
        );
      } else {
        setTabs(s.defaultTerminals);
      }
    })();
  }, [notify]);

  const toggle = async (key: keyof DefaultTerminals, on: boolean) => {
    if (!tabs) return;
    const next = { ...tabs, [key]: on };
    setTabs(next);
    await tryInvoke(() => saveSettings({ defaultTerminals: next }), notify);
  };

  const checkAgain = useCallback(async () => {
    setChecking(true);
    const d = await tryInvoke(
      () => api().invoke('agents:detect', true),
      notify,
    );
    if (d) setDetected(d);
    setChecking(false);
  }, [notify]);

  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .catch(() => notify('error', 'Could not copy to the clipboard.'));

  const foundAndTicked = (id: AgentId) =>
    !!tabs?.[id] && !!detected?.agents[id].found;
  const defaultAgent = (['claude', 'opencode', 'copilot'] as const).find(
    foundAndTicked,
  );

  const body = tabs && (
    <>
      <div className="small muted" style={{ marginBottom: 6 }}>
        Shellie looked for the command-line tools on this machine. Ticked ones
        open as tabs when a task starts; any tab can be added later from a
        task&rsquo;s + menu.
      </div>
      {!detected && (
        <div className="small muted" style={{ marginBottom: 6 }}>
          Could not check which agents are installed.
        </div>
      )}
      <table className="agents-table" style={{ width: '100%' }}>
        <thead>
          <tr className="small muted" style={{ textAlign: 'left' }}>
            <th />
            <th>Agent</th>
            <th>On this machine</th>
            <th>Cost tracking</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {AGENT_IDS.map((id) => {
            const probe = detected?.agents[id];
            return (
              <tr key={id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={AGENT_LABELS[id]}
                    checked={tabs[id]}
                    onChange={(e) => void toggle(id, e.target.checked)}
                  />
                </td>
                <td>
                  <span
                    aria-hidden
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: DOTS[id],
                      marginRight: 6,
                    }}
                  />
                  {AGENT_LABELS[id]}
                </td>
                <td>
                  {!probe
                    ? 'Not checked'
                    : probe.found
                      ? `Found${probe.version ? ` · ${probe.version}` : ''}`
                      : 'Not found'}
                </td>
                <td className="small muted">{COST[id]}</td>
                <td className="small">
                  {probe && !probe.found && (
                    <>
                      <code>{INSTALL_COMMANDS[id]}</code>{' '}
                      <button
                        type="button"
                        className="btn"
                        onClick={() => copy(INSTALL_COMMANDS[id])}
                      >
                        Copy
                      </button>
                    </>
                  )}
                  {id === defaultAgent && (
                    <span className="muted">Default agent</span>
                  )}
                  {id === 'opencode' && (
                    <div className="muted">
                      Pick this if you have no Claude licence
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          <tr>
            <td>
              <input
                type="checkbox"
                aria-label="A shell"
                checked={tabs.shell}
                onChange={(e) => void toggle('shell', e.target.checked)}
              />
            </td>
            <td>A shell</td>
            <td>{detected?.shell.label ?? 'Not checked'}</td>
            <td className="small muted">&mdash;</td>
            <td />
          </tr>
        </tbody>
      </table>
      <div className="small muted" style={{ marginTop: 6 }}>
        Brains run on Claude Code or OpenCode, whichever you pick per brain.
      </div>
      {detected && AGENT_IDS.every((id) => !detected.agents[id].found) && (
        <div className="small muted" style={{ marginTop: 6 }}>
          No agent CLI found. Shellie works with a shell; install one and Check
          again.
        </div>
      )}
      {AGENT_IDS.filter(foundAndTicked).length > 1 && (
        <div className="small" style={{ marginTop: 8 }}>
          <strong>Both found, both ticked?</strong> A task then opens two agent
          tabs. Most people keep one. Untick Claude Code if OpenCode is your
          agent; Shellie installs agent packages (<code>apm</code>) only for the
          ticked ones.
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn"
          disabled={checking}
          onClick={() => void checkAgain()}
        >
          Check again
        </button>
      </div>
    </>
  );

  if (embedded) return <div className="list">{body}</div>;
  const defaults = defaultSettings().defaultTerminals;
  const modified =
    !!tabs &&
    (Object.keys(defaults) as (keyof DefaultTerminals)[]).some(
      (k) => tabs[k] !== defaults[k],
    );
  const reset = async () => {
    setTabs(defaults);
    await tryInvoke(() => saveSettings({ defaultTerminals: defaults }), notify);
  };
  return (
    <SettingsCategory id="terminals" title="Agents and terminals">
      <SettingRow
        id="user-terminals-default"
        category="Agents and terminals"
        title="Default terminals"
        description="The tabs a new task opens, and which agent CLIs are installed."
        keywords={[
          'Claude Code',
          'Copilot CLI',
          'OpenCode',
          'shell',
          'agents',
          'Check again',
        ]}
        modified={modified}
        onReset={() => void reset()}
      >
        {body ?? <div className="muted small">Loading&hellip;</div>}
      </SettingRow>
    </SettingsCategory>
  );
}
