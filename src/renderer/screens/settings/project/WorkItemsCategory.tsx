import type { Connection, StartSettings } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import { SettingsCategory } from '../../../components/settings/SettingRow';
import {
  StartSettingsRows,
  useWorkItemTypes,
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
  const setConnections = useStore((s) => s.setConnections);
  const types = useWorkItemTypes(connection.id, active);

  const save = async (workItemOnStart: StartSettings) => {
    const saved = await tryInvoke(
      () =>
        api().invoke('connections:update', connection.id, { workItemOnStart }),
      notify,
    );
    if (saved)
      setConnections(
        useStore
          .getState()
          .connections.map((c) => (c.id === saved.id ? saved : c)),
      );
  };

  return (
    <SettingsCategory id="project-workitems" title={title}>
      <StartSettingsRows
        value={connection.workItemOnStart}
        onChange={(next) => void save(next)}
        types={types}
        idPrefix="project-workitems"
        scope="project"
        category={title}
      />
    </SettingsCategory>
  );
}
