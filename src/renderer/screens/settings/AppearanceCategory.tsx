import { useEffect, useState } from 'react';
import type { ThemeChoice } from '../../../shared/theme';
import { type AppSettings, defaultSettings } from '../../../shared/usage';
import { api, saveSettings, tryInvoke } from '../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../components/settings/SettingRow';
import { useStore } from '../../store';

type AppearancePatch = Partial<
  Pick<AppSettings, 'showSplash' | 'sendTelemetry' | 'notifyOnDone' | 'theme'>
>;

/** User › Appearance: theme, splash, the agent-done notice and anonymous telemetry, each saved at once. */
export function AppearanceCategory() {
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

  const save = async (patch: AppearancePatch) => {
    if (!settings) return;
    const saved = await tryInvoke(() => saveSettings(patch), notify);
    if (saved) setSettings(saved);
  };

  const defaults = defaultSettings();
  const row = <K extends keyof AppearancePatch>(key: K) => ({
    modified: settings !== null && settings[key] !== defaults[key],
    onReset: () => void save({ [key]: defaults[key] } as AppearancePatch),
  });

  const checkbox = (
    key: 'showSplash' | 'sendTelemetry' | 'notifyOnDone',
    label: string,
  ) => (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={settings?.[key] ?? defaults[key]}
        disabled={!settings}
        onChange={(e) => void save({ [key]: e.target.checked })}
      />{' '}
      {label}
    </label>
  );

  return (
    <SettingsCategory id="appearance" title="Appearance">
      <SettingRow
        id="user-appearance-theme"
        category="Appearance"
        title="Theme"
        description="System follows the operating system's light or dark mode."
        keywords={['light', 'dark', 'System', 'colour', 'color']}
        {...row('theme')}
      >
        <select
          className="field"
          aria-label="Theme"
          value={settings?.theme ?? 'system'}
          disabled={!settings}
          onChange={(e) => void save({ theme: e.target.value as ThemeChoice })}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </SettingRow>
      <SettingRow
        id="user-appearance-splash"
        category="Appearance"
        title="Show splash on start"
        keywords={['splash screen', 'launch']}
        {...row('showSplash')}
      >
        {checkbox('showSplash', 'Show splash on start')}
      </SettingRow>
      <SettingRow
        id="user-appearance-notify"
        category="Appearance"
        title="Notify when an agent finishes"
        keywords={['Notify when an agent finishes its turn', 'notification']}
        {...row('notifyOnDone')}
      >
        {checkbox('notifyOnDone', 'Notify when an agent finishes its turn')}
      </SettingRow>
      <SettingRow
        id="user-appearance-telemetry"
        category="Appearance"
        title="Send anonymous usage data"
        description="Usage events, errors and timings, never names, paths or values."
        keywords={['Send anonymous usage and error data', 'telemetry']}
        {...row('sendTelemetry')}
      >
        {checkbox('sendTelemetry', 'Send anonymous usage and error data')}
      </SettingRow>
    </SettingsCategory>
  );
}
