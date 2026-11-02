import { useEffect, useState } from 'react';
import type { AgentCommands, Repo } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { useStore } from '../../../store';

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

export function AgentsCategory({ repo, title }: { repo: Repo; title: string }) {
  return (
    <SettingsCategory id="repo-agents" title={title}>
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
            <span className="mono">claude --permission-mode acceptEdits</span>.
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
  );
}
