import { AGENT_IDS } from '../../../../shared/agents';
import { ListEditor } from '../../../components/settings/ListEditor';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { Loading } from './GeneralCategory';
import { type RepoSettings, yamlRow } from './useRepoSettings';

type ApmMode = 'auto' | 'off' | 'choose';

export function SetupCategory({
  settings,
  title,
}: {
  settings: RepoSettings;
  title: string;
}) {
  const { config } = settings;
  const apm = config?.apm;
  const mode: ApmMode =
    apm === undefined ? 'auto' : apm === false ? 'off' : 'choose';
  const chosen = Array.isArray(apm) ? apm : [];
  const setMode = (next: ApmMode) => {
    if (next === 'auto') void settings.set('apm', 'auto');
    else if (next === 'off') void settings.set('apm', false);
    else void settings.set('apm', [...AGENT_IDS]);
  };
  const toggle = (target: string, on: boolean) => {
    const next = AGENT_IDS.filter((t) =>
      t === target ? on : chosen.includes(t),
    );
    // No harness ticked is Off, not an empty list.
    void settings.set('apm', next.length > 0 ? next : false);
  };
  return (
    <SettingsCategory id="repo-setup" title={title}>
      <SettingRow
        id="repo-setup-commands"
        scope="repo"
        category="Setup"
        title="Setup commands"
        description="Run in the task's Setup tab once its terminals start, in this order."
        keywords={['npm ci', 'install', 'setup']}
        {...yamlRow(settings, 'setup')}
      >
        {config ? (
          <ListEditor
            label="Setup commands"
            items={config.setup}
            onChange={(next) => void settings.set('setup', next)}
            placeholder="npm ci"
            mono
          />
        ) : (
          <Loading />
        )}
      </SettingRow>
      <SettingRow
        id="repo-setup-apm"
        scope="repo"
        category="Setup"
        title="Agent packages"
        description="Which harnesses apm install targets for a repo with an apm.yml. Automatic follows the task's tabs."
        keywords={['apm', 'apm install', 'claude', 'copilot', 'opencode']}
        {...yamlRow(settings, 'apm')}
      >
        {config ? (
          <>
            <select
              className="field"
              aria-label="Agent packages"
              value={mode}
              onChange={(e) => setMode(e.target.value as ApmMode)}
            >
              <option value="auto">
                Automatic (from the task&rsquo;s tabs)
              </option>
              <option value="off">Off</option>
              <option value="choose">Choose&hellip;</option>
            </select>
            {mode === 'choose' && (
              <div>
                {AGENT_IDS.map((t) => (
                  <label
                    key={t}
                    className="checkbox"
                    style={{ marginRight: 12 }}
                  >
                    <input
                      type="checkbox"
                      checked={chosen.includes(t)}
                      onChange={(e) => toggle(t, e.target.checked)}
                    />{' '}
                    <span className="mono">{t}</span>
                  </label>
                ))}
              </div>
            )}
          </>
        ) : (
          <Loading />
        )}
      </SettingRow>
    </SettingsCategory>
  );
}
