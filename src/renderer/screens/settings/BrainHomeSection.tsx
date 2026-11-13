import { useEffect, useState } from 'react';
import type { BrainHome } from '../../../shared/brainShare';
import { api, tryInvoke } from '../../api';
import { orgName } from '../../components/brain/sharing';
import {
  SettingRow,
  SettingsCategory,
} from '../../components/settings/SettingRow';
import { useStore } from '../../store';

/** Settings: the company's own Azure DevOps project that shared brains can live in, so none goes to a customer's. */
export function BrainHomeSection() {
  const notify = useStore((s) => s.notify);
  const [home, setHome] = useState<BrainHome | null | undefined>(undefined);
  const [organizationUrl, setOrganizationUrl] = useState('');
  const [project, setProject] = useState('');
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api()
      .invoke('brainHome:get')
      .then(
        (h) => live && setHome(h),
        () => live && setHome(null),
      );
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    const saved = await tryInvoke(
      () =>
        api().invoke('brainHome:save', {
          organizationUrl: organizationUrl.trim(),
          project: project.trim(),
          pat: pat.trim(),
        }),
      notify,
    );
    setBusy(false);
    if (!saved) return;
    setHome(saved);
    setPat('');
  };
  const remove = async () => {
    setBusy(true);
    const done = await tryInvoke(async () => {
      await api().invoke('brainHome:remove');
      return true;
    }, notify);
    setBusy(false);
    if (done) {
      setHome(null);
      setOrganizationUrl('');
      setProject('');
    }
  };

  return (
    <SettingsCategory id="brain-home" title="Brain home">
      <SettingRow
        id="user-brain-home"
        category="Brain home"
        title="Company brain home"
        description="An Azure DevOps project of your company where shared brains live. A brain shared there never goes to a customer's organization."
        keywords={['shared brains', 'share', 'colleagues', 'token']}
      >
        {home === undefined ? (
          <div className="muted small">Loading&hellip;</div>
        ) : home ? (
          <div className="conn-form">
            <span className="conn-status-ok">
              {orgName(home.organizationUrl)}/{home.project}
              {home.user ? ` as ${home.user}` : ''}
            </span>
            <div className="actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={remove}
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <form
            className="conn-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label htmlFor="brain-home-org">Organization URL</label>
            <input
              id="brain-home-org"
              className="field mono"
              type="url"
              placeholder="https://dev.azure.com/your-company"
              value={organizationUrl}
              onChange={(e) => setOrganizationUrl(e.target.value)}
            />
            <label htmlFor="brain-home-project">Project</label>
            <input
              id="brain-home-project"
              className="field"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            />
            <label htmlFor="brain-home-pat">Token</label>
            <input
              id="brain-home-pat"
              className="field mono"
              type="password"
              autoComplete="off"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
            />
            <span />
            <div className="actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  busy ||
                  !organizationUrl.trim() ||
                  !project.trim() ||
                  !pat.trim()
                }
              >
                Save
              </button>
            </div>
          </form>
        )}
      </SettingRow>
    </SettingsCategory>
  );
}
