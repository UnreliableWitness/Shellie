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

  // connections:changed is broadcast by the handler and refreshes the store.
  const save = (writeTimeToAdo: boolean) =>
    void tryInvoke(
      () =>
        api().invoke('connections:update', connection.id, { writeTimeToAdo }),
      notify,
    );

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
        onReset={() => save(false)}
      >
        <label className="row small">
          <input
            type="checkbox"
            checked={connection.writeTimeToAdo}
            onChange={(e) => save(e.target.checked)}
          />
          {LABEL}
        </label>
      </SettingRow>
    </SettingsCategory>
  );
}
