import type { Repo, StartSettings } from '../../../../shared/types';
import { effectiveStartSettings } from '../../../../shared/startSettings';
import { api, tryInvoke } from '../../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import {
  StartSettingsRows,
  useProjectTypes,
} from '../../../components/settings/StartSettingsRows';
import { useStore } from '../../../store';

const CATEGORY = 'Work items on start';

/**
 * What Start does to the work item for this repo: its project's default unless the repo overrides it. A repo
 * with no project has only its own value (nothing to inherit).
 */
export function WorkItemsCategory({
  repo,
  active,
  title,
}: {
  repo: Repo;
  active: boolean;
  title: string;
}) {
  const notify = useStore((s) => s.notify);
  const connections = useStore((s) => s.connections);
  const project = connections.find((c) => c.id === repo.connectionId) ?? null;
  const settings = effectiveStartSettings(repo, project);
  const own = repo.workItemOnStart !== undefined;
  const types = useProjectTypes(
    repo.connectionId,
    active && (own || !project),
  );

  // repos:changed is broadcast by the handlers and refreshes the store.
  const save = (next: StartSettings) =>
    void tryInvoke(
      () => api().invoke('repos:setWorkItemOnStart', repo.id, next),
      notify,
    );
  const clear = () =>
    void tryInvoke(
      () => api().invoke('repos:clearWorkItemOnStart', repo.id),
      notify,
    );

  return (
    <SettingsCategory id="repo-workitems" title={title}>
      {project && (
        <SettingRow
          id="repo-workitems-source"
          scope="repo"
          category={CATEGORY}
          title="Source"
          description="A repo inherits its project's settings unless it overrides them."
          keywords={['inherit', 'override', 'project default']}
        >
          {own ? (
            <div className="row small">
              <span>Overridden here</span>
              <button type="button" className="btn" onClick={clear}>
                Reset to project default
              </button>
            </div>
          ) : (
            <div className="row small">
              <span>Inherited from {project.project}</span>
              <button
                type="button"
                className="btn"
                onClick={() => save(settings)}
              >
                Override
              </button>
            </div>
          )}
        </SettingRow>
      )}
      {(own || !project) && (
        <StartSettingsRows
          value={settings}
          onChange={save}
          types={types}
          scope="repo"
          category={CATEGORY}
          disabled={!repo.connectionId}
          hint={
            repo.connectionId ? undefined : 'Link a project in General first'
          }
        />
      )}
    </SettingsCategory>
  );
}
