import { useEffect, useState } from 'react';
import type { Connection } from '../../shared/types';
import { api, saveSettings, tryInvoke } from '../api';
import { statusText } from '../connectionStatus';
import { useStore } from '../store';
import { connectionSection } from './GitAuthNotice';
import { errorMessage } from '../../shared/errors';
import { ProviderPicker, type ProviderChoice } from './ProviderPicker';
import { SettingRow, SettingsCategory } from './settings/SettingRow';

/** One project of an organization: its name opens its Project scope (Verify, Remove and the rest live there). */
function ConnectionRow({ connection }: { connection: Connection }) {
  const go = useStore((s) => s.go);
  const status = statusText(connection);
  return (
    <div className="list-row" id={connectionSection(connection.id)}>
      <div className="grow">
        <button
          type="button"
          className="link"
          style={{ fontWeight: 600 }}
          onClick={() =>
            go({
              kind: 'settings',
              scope: 'project',
              connectionId: connection.id,
            })
          }
        >
          {connection.project}
        </button>
        <span className="small muted">{connection.name}</span>
        <span className={status.ok ? 'conn-status-ok' : 'conn-status-bad'}>
          {status.text}
        </span>
      </div>
    </div>
  );
}

/** One organization: its connections (one per project), Add a project and one Update token for all of them. */
function OrganizationGroup({ connections }: { connections: Connection[] }) {
  const go = useStore((s) => s.go);
  // Opened from a git sign-in failure ("Update token"), the group starts with its token form open.
  const section = useStore((s) =>
    s.screen.kind === 'settings' ? s.screen.section : undefined,
  );
  const asked = connections.some((c) => section === connectionSection(c.id));
  const [updating, setUpdating] = useState(asked);
  const first = connections[0];
  return (
    <div className="conn-group">
      <div className="conn-group-head">
        <div className="grow">
          <span style={{ fontWeight: 600 }}>
            {organizationName(first.organizationUrl)}
          </span>
          <span className="mono small muted">{first.organizationUrl}</span>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            go({ kind: 'connect', from: 'settings', connectionId: first.id })
          }
        >
          Add a project
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setUpdating(true)}
          disabled={updating}
        >
          Update token
        </button>
      </div>
      {updating && (
        <UpdateTokenForm
          connections={connections}
          onDone={() => setUpdating(false)}
        />
      )}
      {connections.map((c) => (
        <ConnectionRow key={c.id} connection={c} />
      ))}
    </div>
  );
}

/** `contoso` for `https://dev.azure.com/contoso` or `https://contoso.visualstudio.com`. */
export function organizationName(organizationUrl: string): string {
  try {
    const url = new URL(organizationUrl);
    return url.hostname.endsWith('.visualstudio.com')
      ? url.hostname.split('.')[0]
      : (url.pathname.split('/').filter(Boolean)[0] ?? organizationUrl);
  } catch {
    return organizationUrl;
  }
}

/** Replaces the token of every connection of an organization, each checked against Azure DevOps like a new one. */
export function UpdateTokenForm({
  connections,
  onDone,
}: {
  connections: Connection[];
  onDone: () => void;
}) {
  const setConnections = useStore((s) => s.setConnections);
  const [pat, setPat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = `conn-pat-${connections[0].id}`;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      for (const connection of connections)
        await api().invoke('connections:save', {
          id: connection.id,
          name: connection.name,
          organizationUrl: connection.organizationUrl,
          project: connection.project,
          pat,
        });
      setConnections(await api().invoke('connections:list'));
      setPat('');
      onDone();
    } catch (e) {
      // A save that did go through reaches the list through connections:changed.
      const message = errorMessage(e);
      setError(pat ? message.split(pat).join('***') : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="conn-form">
      <label htmlFor={inputId}>New personal access token</label>
      <input
        id={inputId}
        className="field mono"
        type="password"
        autoComplete="off"
        autoFocus
        value={pat}
        onChange={(e) => setPat(e.target.value)}
      />
      {error && (
        <div
          role="alert"
          className="conn-status-bad"
          style={{ gridColumn: '1 / -1' }}
        >
          {error}
        </div>
      )}
      <div className="small muted" style={{ gridColumn: '1 / -1' }}>
        The token needs Work Items (Read & write), Code (Read & write) and
        Project and Team (Read). It replaces the token of every project of this
        organization; git uses it to fetch and push the organization&apos;s
        repos.
      </div>
      <div className="actions">
        <button type="button" className="btn" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={busy || !pat.trim()}
        >
          Save token
        </button>
      </div>
    </div>
  );
}

export function ConnectionsSection() {
  const connections = useStore((s) => s.connections);
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const [noTracker, setNoTracker] = useState(false);

  useEffect(() => {
    let live = true;
    void api()
      .invoke('settings:get')
      .then((s) => live && setNoTracker(s.onboarding.tracker === 'none'))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const choose = async (value: ProviderChoice) => {
    const none = value === 'none';
    if (none === noTracker) return;
    const saved = await tryInvoke(
      () =>
        saveSettings((f) => ({
          onboarding: { ...f.onboarding, tracker: none ? 'none' : null },
        })),
      notify,
    );
    if (saved) setNoTracker(none);
  };

  const groups = new Map<string, Connection[]>();
  for (const c of connections) {
    const key = `${c.provider} ${c.organizationUrl}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  return (
    <SettingsCategory
      id="ado"
      title="Projects"
      commands={
        noTracker ? undefined : (
          <button
            type="button"
            className="btn"
            onClick={() => go({ kind: 'connect', from: 'settings' })}
          >
            Add connection&hellip;
          </button>
        )
      }
    >
      <SettingRow
        id="user-conn-tracker"
        category="Projects"
        title="Work item tracker"
        description="Where tasks get their work items from."
        keywords={['Azure DevOps', 'GitHub', 'No tracker', 'provider']}
        modified={noTracker}
        onReset={() => void choose('azure-devops')}
      >
        <ProviderPicker
          value={noTracker ? 'none' : 'azure-devops'}
          onChange={(v) => void choose(v)}
        />
      </SettingRow>
      <SettingRow
        id="user-conn-ado"
        category="Projects"
        title="Azure DevOps"
        description="Organizations and projects Shellie reads work items from, with their personal access token."
        keywords={[
          'organization',
          'project',
          'personal access token',
          'PAT',
          'Update token',
          'Add a project',
          'Connections',
        ]}
      >
        <div className="list">
          {connections.length === 0 && (
            <div className="empty">
              {noTracker
                ? 'Tasks start blank on a branch: no work item, nothing written back.'
                : 'No connections yet. Add your organization and pick its projects with a personal access token.'}
            </div>
          )}
          {[...groups].map(([key, list]) => (
            <OrganizationGroup key={key} connections={list} />
          ))}
        </div>
      </SettingRow>
    </SettingsCategory>
  );
}
