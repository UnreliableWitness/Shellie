import { useEffect, useState } from 'react';
import type { StartSettings, WorkItemTypeMeta } from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import { useStore } from '../../store';
import { SettingRow } from './SettingRow';

/** A project's work item types, loaded while `active`; null while loading or without a project. */
export function useWorkItemTypes(
  connectionId: string | null,
  active: boolean,
): WorkItemTypeMeta[] | null {
  const notify = useStore((s) => s.notify);
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
  return types;
}

/**
 * The three "work items on start" controls, shared by the Project scope (the default) and the Repository scope
 * (an override). Reset goes back to the app default. `types` null means still loading; `disabled` greys the
 * controls and shows `hint` in their place.
 */
export function StartSettingsRows({
  value,
  onChange,
  types,
  idPrefix,
  scope,
  category,
  disabled = false,
  hint,
}: {
  value: StartSettings;
  onChange(next: StartSettings): void;
  types: WorkItemTypeMeta[] | null;
  idPrefix: 'project-workitems' | 'repo-workitems';
  scope: 'project' | 'repo';
  category: string;
  disabled?: boolean;
  hint?: string;
}) {
  const choose = (type: string, state: string) => {
    const { [type]: _removed, ...rest } = value.stateOverrides;
    onChange({
      ...value,
      stateOverrides: state ? { ...rest, [type]: state } : rest,
    });
  };

  const hintLine = hint ? <div className="muted small">{hint}</div> : null;
  const overridden = Object.keys(value.stateOverrides).length > 0;

  return (
    <>
      <SettingRow
        id={`${idPrefix}-move`}
        scope={scope}
        category={category}
        title="Move to In Progress"
        description="Start moves the work item to its type's In Progress state."
        keywords={['Move the work item to In Progress on start', 'state']}
        modified={!value.moveToInProgress}
        onReset={() => onChange({ ...value, moveToInProgress: true })}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.moveToInProgress}
            onChange={(e) =>
              onChange({ ...value, moveToInProgress: e.target.checked })
            }
          />{' '}
          Move the work item to In Progress on start
        </label>
        {hintLine}
      </SettingRow>
      <SettingRow
        id={`${idPrefix}-assign`}
        scope={scope}
        category={category}
        title="Assign to me"
        description="Start assigns an unassigned work item to you."
        keywords={['Assign it to me if unassigned']}
        modified={!value.assignToMe}
        onReset={() => onChange({ ...value, assignToMe: true })}
      >
        <label className="checkbox">
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.assignToMe}
            onChange={(e) =>
              onChange({ ...value, assignToMe: e.target.checked })
            }
          />{' '}
          Assign it to me if unassigned
        </label>
        {hintLine}
      </SettingRow>
      <SettingRow
        id={`${idPrefix}-states`}
        scope={scope}
        category={category}
        title="In Progress state per type"
        description="The state Start moves each work item type to; Default is the type's first In Progress state."
        keywords={['type', 'state', 'override']}
        modified={overridden}
        onReset={() => onChange({ ...value, stateOverrides: {} })}
      >
        {disabled ? (
          hintLine
        ) : types === null ? (
          <div className="muted small">Loading&hellip;</div>
        ) : (
          types.map((t) => (
            <div key={t.name} className="small" style={{ marginTop: 4 }}>
              <span>{t.name}</span>{' '}
              <select
                className="field"
                aria-label={`In Progress state for ${t.name}`}
                value={value.stateOverrides[t.name] ?? ''}
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
    </>
  );
}
