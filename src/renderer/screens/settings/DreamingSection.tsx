import type { DreamView } from '../../../shared/dreams';
import type { Connection } from '../../../shared/types';
import { useDreams } from '../../components/dreams/useDreams';
import {
  SettingRow,
  SettingsCategory,
} from '../../components/settings/SettingRow';
import { useStore } from '../../store';
import { limitLabel } from '../../components/dreams/folders';

const stateLine = (v: DreamView): string => {
  if (v.settings.enabled) return 'Dreaming is on';
  return 'Dreaming is off';
};

/** Settings › Project: what the project's dreaming is set to, read only; its Dreams screen changes it. */
export function DreamingSection({
  connection,
  title,
}: {
  connection: Connection;
  title: string;
}) {
  const go = useStore((s) => s.go);
  const setConnectionId = useStore((s) => s.setConnectionId);
  const view = useDreams(connection.id);
  return (
    <SettingsCategory id="project-dreaming" title={title}>
      <SettingRow
        id="project-dreaming-state"
        category="Dreaming"
        title="Dreaming"
        description="While you are away, Shellie reads what was said in the agent sessions of this project's repos and proposes better skills and rules on a branch you review."
        keywords={['dream', 'dreams', 'opencode', 'skills', 'rules']}
      >
        {view === null ? (
          <div className="muted small">Loading&hellip;</div>
        ) : (
          <div className="conn-form">
            <span>{stateLine(view)}</span>
            <span>
              Model:{' '}
              <span className="mono">
                {view.settings.model ?? 'Not chosen'}
              </span>
            </span>
            <span>Limit: {limitLabel(view.settings.limit)}</span>
            <div className="actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  // Dreams shows the active project: this one.
                  setConnectionId(connection.id);
                  go({ kind: 'dreams' });
                }}
              >
                Open Dreams
              </button>
            </div>
          </div>
        )}
      </SettingRow>
    </SettingsCategory>
  );
}
