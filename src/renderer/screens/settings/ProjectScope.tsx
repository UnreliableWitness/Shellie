import type { Connection } from '../../../shared/types';
import { BrainsCategory } from './project/BrainsCategory';
import { ConnectionCategory } from './project/ConnectionCategory';
import { DangerCategory } from './project/DangerCategory';
import { TimeCategory } from './project/TimeCategory';
import { WorkItemsCategory } from './project/WorkItemsCategory';
import type { SettingsCategoryInfo } from './UserScope';

/** The Project scope's categories, in tree order. */
export const PROJECT_CATEGORIES: SettingsCategoryInfo[] = [
  { id: 'project-connection', title: 'Connection' },
  { id: 'project-workitems', title: 'Work items on start' },
  { id: 'project-time', title: 'Time' },
  { id: 'project-brains', title: 'Brains' },
  { id: 'project-danger', title: 'Danger zone' },
];

const title = (id: string) =>
  PROJECT_CATEGORIES.find((c) => c.id === id)?.title ?? id;

/** One project's (connection's) settings. `active` is false while the scope is mounted hidden (for search counts). */
export function ProjectScope({
  connection,
  active,
}: {
  connection: Connection;
  active: boolean;
}) {
  return (
    <>
      <ConnectionCategory
        connection={connection}
        title={title('project-connection')}
      />
      <WorkItemsCategory
        connection={connection}
        active={active}
        title={title('project-workitems')}
      />
      <TimeCategory connection={connection} title={title('project-time')} />
      <BrainsCategory
        connection={connection}
        active={active}
        title={title('project-brains')}
      />
      <DangerCategory connection={connection} title={title('project-danger')} />
    </>
  );
}
