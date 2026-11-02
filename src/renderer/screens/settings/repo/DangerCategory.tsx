import { useState } from 'react';
import type { Repo } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { ConfirmBar } from '../../../components/ui/ConfirmBar';
import { useStore } from '../../../store';

export function DangerCategory({ repo, title }: { repo: Repo; title: string }) {
  const notify = useStore((s) => s.notify);
  const setRepos = useStore((s) => s.setRepos);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    // A repo with open tasks is refused; the error shows as a notice.
    const ok = await tryInvoke(async () => {
      await api().invoke('repos:remove', repo.id);
      return true;
    }, notify);
    setBusy(false);
    setConfirming(false);
    if (ok) setRepos(await api().invoke('repos:list'));
  };

  return (
    <SettingsCategory id="repo-danger" title={title}>
      <SettingRow
        id="repo-danger-remove"
        scope="repo"
        category="Danger zone"
        title="Remove repository"
        description="Shellie forgets this repo; the folder and its files stay."
        keywords={['delete', 'remove from Shellie']}
      >
        {confirming ? (
          <ConfirmBar
            message={`Remove ${repo.name} from Shellie?`}
            details="The folder and its files stay on disk."
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
            Remove repository
          </button>
        )}
      </SettingRow>
    </SettingsCategory>
  );
}
