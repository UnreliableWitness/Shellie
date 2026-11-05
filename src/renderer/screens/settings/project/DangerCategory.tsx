import { useState } from 'react';
import type { Connection } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { ConfirmBar } from '../../../components/ui/ConfirmBar';
import { useBrains } from '../../../hooks/useBrains';
import { useStore } from '../../../store';

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export function DangerCategory({
  connection,
  title,
}: {
  connection: Connection;
  title: string;
}) {
  const notify = useStore((s) => s.notify);
  const go = useStore((s) => s.go);
  const setConnections = useStore((s) => s.setConnections);
  const setRepos = useStore((s) => s.setRepos);
  const repos = useStore(
    (s) => s.repos.filter((r) => r.connectionId === connection.id).length,
  );
  const brains = useBrains().filter(
    (b) => b.connectionId === connection.id && !b.archived,
  ).length;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    const ok = await tryInvoke(async () => {
      await api().invoke('connections:remove', connection.id);
      return true;
    }, notify);
    setBusy(false);
    setConfirming(false);
    if (!ok) return;
    const list = await tryInvoke(
      () => api().invoke('connections:list'),
      notify,
    );
    if (list) setConnections(list);
    const repoList = await tryInvoke(() => api().invoke('repos:list'), notify);
    if (repoList) setRepos(repoList);
    go({ kind: 'settings', scope: 'user', section: 'ado' });
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
            details={`${count(repos, 'repository', 'repositories')} will be unlinked and ${count(brains, 'brain', 'brains')} archived.`}
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
