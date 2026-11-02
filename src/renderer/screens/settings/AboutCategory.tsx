import { useEffect, useState } from 'react';
import { api, saveSettings, tryInvoke } from '../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../components/settings/SettingRow';
import { MindMark } from '../../components/ui';
import { useStore } from '../../store';

/** User › About: the app and its version, and the way back to the Get started page. */
export function AboutCategory() {
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
    <SettingsCategory id="about" title="About">
      <SettingRow
        id="user-about-version"
        category="About"
        title="Version"
        keywords={['Shellie', 'release', 'update']}
      >
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
          </div>
        </div>
      </SettingRow>
      <SettingRow
        id="user-about-get-started"
        category="About"
        title="Get started"
        description="Shows the Get started page and its band on Home again."
        keywords={['onboarding', 'setup']}
      >
        <button
          type="button"
          className="link"
          onClick={() => void getStarted()}
        >
          Get started
        </button>
      </SettingRow>
    </SettingsCategory>
  );
}
