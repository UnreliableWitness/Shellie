import type { DreamView } from '../../../shared/dreams';
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

/** Settings: what dreaming is set to, read only; the Dreams screen changes it. */
export function DreamingSection() {
  const go = useStore((s) => s.go);
  const view = useDreams();
  return (
    <SettingsCategory id="dreaming" title="Dreaming">
      <SettingRow
        id="user-dreaming"
        category="Dreaming"
        title="Dreaming"
        description="While you are away, Shellie reads what was said in a repo's agent sessions and proposes better skills and rules on a branch you review."
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
                onClick={() => go({ kind: 'dreams' })}
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
