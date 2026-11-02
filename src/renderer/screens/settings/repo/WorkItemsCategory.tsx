import { useEffect, useState } from 'react';
import type {
  Repo,
  StartSettings,
  WorkItemTypeMeta,
} from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { useStore } from '../../../store';

const NO_CONNECTION = 'Link a connection in General first';

/** What Start does to the work item; stored on the repo (no file layer), Reset goes back to the app default. */
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
  const settings = repo.workItemOnStart;
  const connectionId = repo.connectionId;
  const linked = connectionId !== null;
  const [types, setTypes] = useState<WorkItemTypeMeta[] | null>(null);

  useEffect(() => {
    if (!active || !connectionId) return;
    let live = true;
    setTypes(null);
    void tryInvoke(
      () => api().invoke('workItems:types', connectionId),
      notify,
    ).then((result) => {
      if (live && result) setTypes(result);
    });
    return () => {
      live = false;
    };
  }, [active, connectionId, notify]);

  // repos:changed is broadcast by the handler and refreshes the store.
  const save = (next: StartSettings) =>
    void tryInvoke(
      () => api().invoke('repos:setWorkItemOnStart', repo.id, next),
      notify,
    );

  const choose = (type: string, state: string) => {
    const { [type]: _removed, ...rest } = settings.stateOverrides;
    save({
      ...settings,
      stateOverrides: state ? { ...rest, [type]: state } : rest,
    });
  };

  const hint = linked ? null : (
    <div className="muted small">{NO_CONNECTION}</div>
  );
  const overridden = Object.keys(settings.stateOverrides).length > 0;

  return (
    <SettingsCategory id="repo-workitems" title={title}>
      <SettingRow
        id="repo-workitems-move"
        scope="repo"
        category="Work items on start"
        title="Move to In Progress"
        description="Start moves the work item to its type's In Progress state."
        keywords={['Move the work item to In Progress on start', 'state']}
        modified={!settings.moveToInProgress}
        onReset={() => save({ ...settings, moveToInProgress: true })}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            disabled={!linked}
            checked={settings.moveToInProgress}
            onChange={(e) =>
              save({ ...settings, moveToInProgress: e.target.checked })
            }
          />{' '}
          Move the work item to In Progress on start
        </label>
        {hint}
      </SettingRow>
      <SettingRow
        id="repo-workitems-assign"
        scope="repo"
        category="Work items on start"
        title="Assign to me"
        description="Start assigns an unassigned work item to you."
        keywords={['Assign it to me if unassigned']}
        modified={!settings.assignToMe}
        onReset={() => save({ ...settings, assignToMe: true })}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            disabled={!linked}
            checked={settings.assignToMe}
            onChange={(e) =>
              save({ ...settings, assignToMe: e.target.checked })
            }
          />{' '}
          Assign it to me if unassigned
        </label>
        {hint}
      </SettingRow>
      <SettingRow
        id="repo-workitems-states"
        scope="repo"
        category="Work items on start"
        title="In Progress state per type"
        description="The state Start moves each work item type to; Default is the type's first In Progress state."
        keywords={['type', 'state', 'override']}
        modified={overridden}
        onReset={() => save({ ...settings, stateOverrides: {} })}
      >
        {!linked ? (
          hint
        ) : types === null ? (
          <div className="muted small">Loading&hellip;</div>
        ) : (
          types.map((t) => (
            <div key={t.name} className="small" style={{ marginTop: 4 }}>
              <span>{t.name}</span>{' '}
              <select
                className="field"
                aria-label={`In Progress state for ${t.name}`}
                value={settings.stateOverrides[t.name] ?? ''}
                onChange={(e) => choose(t.name, e.target.value)}
              >
                <option value="">Default</option>
                {t.states
                  .filter((s) => s.category === 'InProgress')
                  .map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </div>
          ))
        )}
      </SettingRow>
    </SettingsCategory>
  );
}
