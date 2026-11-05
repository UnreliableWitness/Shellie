import type { Connection, StartSettings } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import { SettingsCategory } from '../../../components/settings/SettingRow';
import {
  StartSettingsRows,
  useProjectTypes,
} from '../../../components/settings/StartSettingsRows';
import { useStore } from '../../../store';

/** What Start does to the work item: the project's default, which its repos inherit unless they override it. */
export function WorkItemsCategory({
  connection,
  active,
  title,
}: {
  connection: Connection;
  active: boolean;
  title: string;
}) {
  const notify = useStore((s) => s.notify);
  const types = useProjectTypes(connection.id, active);

  // connections:changed is broadcast by the handler and refreshes the store.
  const save = (workItemOnStart: StartSettings) =>
    void tryInvoke(
      () =>
        api().invoke('connections:update', connection.id, { workItemOnStart }),
      notify,
    );

  return (
    <SettingsCategory id="project-workitems" title={title}>
      <StartSettingsRows
        value={connection.workItemOnStart}
        onChange={save}
        types={types}
        scope="project"
        category={title}
      />
    </SettingsCategory>
  );
}
