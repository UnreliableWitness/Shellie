import { useState } from 'react';
import type { Connection } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { ConfirmBar } from '../../../components/ui/ConfirmBar';
import { plural } from '../../../format';
import { useBrains } from '../../../hooks/useBrains';
import { useStore } from '../../../store';

/** Removing the project: Shellie forgets the connection, unlinks its repos and archives its brains. */
export function DangerCategory({
  connection,
  title,
}: {
  connection: Connection;
  title: string;
}) {
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const repos = useStore(
    (s) => s.repos.filter((r) => r.connectionId === connection.id).length,
  );
  const brains = useBrains().filter(
    (b) => b.connectionId === connection.id && !b.archived,
  ).length;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  // connections:changed and repos:changed are broadcast by the handler and refresh the store.
  const remove = async () => {
    setBusy(true);
    try {
      const ok = await tryInvoke(async () => {
        await api().invoke('connections:remove', connection.id);
        return true;
      }, notify);
      if (ok) go({ kind: 'settings', scope: 'user', section: 'ado' });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <SettingsCategory id="project-danger" title={title}>
      <SettingRow
        id="project-danger-remove"
        scope="project"
        category={title}
        title="Remove project"
        description="Shellie forgets this project; its repositories stay, unlinked."
        keywords={['delete', 'remove connection', 'disconnect']}
      >
        {confirming ? (
          <ConfirmBar
            message={`Remove ${connection.project} from Shellie?`}
            details={`${plural(repos, 'repository', 'repositories')} will be unlinked and ${plural(brains, 'brain')} archived.`}
            confirmLabel="Remove"
            busy={busy}
            onConfirm={() => void remove()}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => setConfirming(true)}
          >
            Remove project
          </button>
        )}
      </SettingRow>
    </SettingsCategory>
  );
}
