import { KeyValueEditor } from '../../../components/settings/KeyValueEditor';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { Loading } from './GeneralCategory';
import { type RepoSettings, yamlRow } from './useRepoSettings';

export function RunCategory({
  settings,
  title,
}: {
  settings: RepoSettings;
  title: string;
}) {
  const { config } = settings;
  return (
    <SettingsCategory id="repo-run" title={title}>
      <SettingRow
        id="repo-run-commands"
        scope="repo"
        category="Run"
        title="Run commands"
        description="Named commands a task can run in a tab, such as the dev server."
        keywords={['run', 'dev server', 'npm run dev', 'start']}
        {...yamlRow(settings, 'run')}
      >
        {config ? (
          <KeyValueEditor
            label="Run commands"
            value={config.run}
            onChange={(next) => void settings.set('run', next)}
            keyLabel="Name"
            valueLabel="Command"
          />
        ) : (
          <Loading />
        )}
      </SettingRow>
    </SettingsCategory>
  );
}
