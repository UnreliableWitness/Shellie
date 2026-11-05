import { useState } from 'react';
import type { Connection } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import {
  organizationName,
  UpdateTokenForm,
} from '../../../components/ConnectionsSection';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { statusText } from '../../../connectionStatus';
import { useStore } from '../../../store';

/** The project's link to Azure DevOps: its status, the organization's token and who I am there. */
export function ConnectionCategory({
  connection,
  title,
}: {
  connection: Connection;
  title: string;
}) {
  const notify = useStore((s) => s.notify);
  const setConnections = useStore((s) => s.setConnections);
  const connections = useStore((s) => s.connections);
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState(false);
  const status = statusText(connection);
  // The token is per organization: every project of it shares the one PAT.
  const siblings = connections.filter(
    (c) =>
      c.provider === connection.provider &&
      c.organizationUrl === connection.organizationUrl,
  );
  const organization = organizationName(connection.organizationUrl);

  const verify = async () => {
    setBusy(true);
    try {
      await tryInvoke(
        () => api().invoke('connections:verify', connection.id),
        notify,
      );
      const list = await tryInvoke(
        () => api().invoke('connections:list'),
        notify,
      );
      if (list) setConnections(list);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCategory id="project-connection" title={title}>
      <SettingRow
        id="project-conn-status"
        scope="project"
        category={title}
        title="Status"
        description="Whether Shellie can reach the project with the token."
        keywords={['Verify', 'connected', 'token rejected', 'unreachable']}
      >
        <div className="row">
          <span
            className={`grow ${status.ok ? 'conn-status-ok' : 'conn-status-bad'}`}
          >
            {status.text}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void verify()}
            disabled={busy}
          >
            Verify
          </button>
        </div>
      </SettingRow>
      <SettingRow
        id="project-conn-token"
        scope="project"
        category={title}
        title="Token"
        description={`One token for all ${siblings.length} ${siblings.length === 1 ? 'project' : 'projects'} of ${organization}`}
        keywords={['personal access token', 'PAT', 'Update token']}
      >
        {updating ? (
          <UpdateTokenForm
            connections={siblings}
            onDone={() => setUpdating(false)}
          />
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => setUpdating(true)}
          >
            Update token
          </button>
        )}
      </SettingRow>
      <SettingRow
        id="project-conn-identity"
        scope="project"
        category={title}
        title="Who I am there"
        description="The Azure DevOps user the token belongs to."
        keywords={['user', 'account', 'identity']}
      >
        <div>
          <span style={{ fontWeight: 600 }}>
            {connection.user ?? 'Unknown user'}
          </span>{' '}
          {connection.userUniqueName && (
            <span className="small muted">{connection.userUniqueName}</span>
          )}
        </div>
      </SettingRow>
    </SettingsCategory>
  );
}
