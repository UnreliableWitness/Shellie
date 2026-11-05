import type { Connection } from '../../../../shared/types';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { BrainsForConnection } from '../BrainsSection';

/** This project's brains, with create, archive, restore and options. */
export function BrainsCategory({
  connection,
  active,
  title,
}: {
  connection: Connection;
  active: boolean;
  title: string;
}) {
  return (
    <SettingsCategory id="project-brains" title={title}>
      <SettingRow
        id="project-brains-list"
        scope="project"
        category={title}
        title="Brains"
        description={`Brains for ${connection.project}.`}
        keywords={['brain', 'wiki', 'second brain', 'New brain', 'archive']}
      >
        {/* Hidden (only counted for search), the create form would query Azure DevOps for wikis. */}
        {active ? <BrainsForConnection connection={connection} /> : null}
      </SettingRow>
    </SettingsCategory>
  );
}
