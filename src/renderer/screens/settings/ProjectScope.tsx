import type { Connection } from '../../../shared/types';
import { SettingsCategory } from '../../components/settings/SettingRow';
import type { SettingsCategoryInfo } from './UserScope';

/** The Project scope's categories, in tree order. */
export const PROJECT_CATEGORIES: SettingsCategoryInfo[] = [
  { id: 'project-connection', title: 'Connection' },
  { id: 'project-workitems', title: 'Work items on start' },
  { id: 'project-time', title: 'Time' },
  { id: 'project-brains', title: 'Brains' },
  { id: 'project-danger', title: 'Danger zone' },
];

/**
 * One project's (connection's) settings. `active` is false while the scope is mounted hidden (for search
 * counts). The categories are empty until their rows land.
 */
export function ProjectScope({
  connection,
  active,
}: {
  connection: Connection;
  active: boolean;
}) {
  void connection;
  void active;
  return (
    <>
      {PROJECT_CATEGORIES.map((c) => (
        <SettingsCategory key={c.id} id={c.id} title={c.title}>
          {null}
        </SettingsCategory>
      ))}
    </>
  );
}
