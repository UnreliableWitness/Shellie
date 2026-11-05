import type { Connection } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { useStore } from '../../../store';

const LABEL = 'Write booked time to Azure DevOps';

/** Whether booked time goes back to this project's work items. */
export function TimeCategory({
  connection,
  title,
}: {
  connection: Connection;
  title: string;
}) {
  const notify = useStore((s) => s.notify);
  const setConnections = useStore((s) => s.setConnections);

  const save = async (writeTimeToAdo: boolean) => {
    const saved = await tryInvoke(
      () =>
        api().invoke('connections:update', connection.id, { writeTimeToAdo }),
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
    <SettingsCategory id="project-time" title={title}>
      <SettingRow
        id="project-time-ado"
        scope="project"
        category={title}
        title={LABEL}
        description="Booked hours go to the work item's Completed Work and Remaining Work."
        keywords={['time tracking', 'completed work', 'hours']}
        modified={connection.writeTimeToAdo}
        onReset={() => void save(false)}
      >
        <label className="row small">
          <input
            type="checkbox"
            checked={connection.writeTimeToAdo}
            onChange={(e) => void save(e.target.checked)}
          />
          {LABEL}
        </label>
      </SettingRow>
    </SettingsCategory>
  );
}
