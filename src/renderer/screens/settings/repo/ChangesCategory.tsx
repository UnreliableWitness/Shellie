import { ListEditor } from '../../../components/settings/ListEditor';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { Loading } from './GeneralCategory';
import { type RepoSettings, yamlRow } from './useRepoSettings';

export function ChangesCategory({
  settings,
  title,
}: {
  settings: RepoSettings;
  title: string;
}) {
  const { config } = settings;
  return (
    <SettingsCategory id="repo-changes" title={title}>
      <SettingRow
        id="repo-changes-collapse"
        scope="repo"
        category="Changes"
        title="Generated files"
        description="Globs the Changes page collapses under Generated."
        keywords={['review', 'collapse', 'glob', 'generated']}
        {...yamlRow(settings, 'reviewCollapse')}
      >
        {config ? (
          <ListEditor
            label="Generated files"
            items={config.reviewCollapse ?? []}
            onChange={(next) => void settings.set('reviewCollapse', next)}
            placeholder="src/generated/**"
            mono
          />
        ) : (
          <Loading />
        )}
      </SettingRow>
    </SettingsCategory>
  );
}
