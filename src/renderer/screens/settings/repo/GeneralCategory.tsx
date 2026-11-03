import { useEffect, useRef, useState } from 'react';
import { renderBranch } from '../../../../shared/naming';
import type { Repo } from '../../../../shared/types';
import { api, tryInvoke } from '../../../api';
import {
  SettingRow,
  SettingsCategory,
} from '../../../components/settings/SettingRow';
import { useStore } from '../../../store';
import { type RepoSettings, yamlRow } from './useRepoSettings';

const EXAMPLE = {
  workItem: {
    id: '1234',
    type: 'User Story',
    title: 'Add login page',
    url: null,
    project: null,
  },
  name: '',
};

/** A text field that saves on Enter or on leaving it; Escape and an empty value put the saved one back. */
function CommitInput({
  label,
  value,
  onCommit,
  onDraft,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  onDraft?: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Set by a save until the next edit, so the blur after Enter does not save the same draft again.
  const committed = useRef(false);
  useEffect(() => {
    committed.current = false;
    setDraft(value);
  }, [value]);
  const change = (v: string) => {
    committed.current = false;
    setDraft(v);
    onDraft?.(v);
  };
  const commit = () => {
    if (committed.current) return;
    const v = draft.trim();
    if (!v) return change(value);
    if (v !== value) {
      committed.current = true;
      onCommit(v);
    }
  };
  return (
    <input
      className="field mono"
      aria-label={label}
      value={draft}
      onChange={(e) => change(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') change(value);
      }}
    />
  );
}

export function GeneralCategory({
  repo,
  settings,
  title,
}: {
  repo: Repo;
  settings: RepoSettings;
  title: string;
}) {
  const notify = useStore((s) => s.notify);
  const connections = useStore((s) => s.connections);
  const { config } = settings;
  const [pattern, setPattern] = useState<string | null>(null);
  // A saved (or reloaded) pattern replaces the draft the preview showed.
  useEffect(() => setPattern(null), [config?.branch]);
  const shownPattern = pattern ?? config?.branch ?? '';
  return (
    <SettingsCategory id="repo-general" title={title}>
      <SettingRow
        id="repo-general-base"
        scope="repo"
        category="General"
        title="Base branch"
        description="The branch a new task's branch starts from."
        keywords={['base', 'main', 'develop']}
        {...yamlRow(settings, 'base')}
      >
        {config ? (
          <CommitInput
            label="Base branch"
            value={config.base}
            onCommit={(v) => void settings.set('base', v)}
          />
        ) : (
          <Loading />
        )}
      </SettingRow>
      <SettingRow
        id="repo-general-branch"
        scope="repo"
        category="General"
        title="Branch name pattern"
        description="How a task's branch is named: {type} is feature or bugfix, {id} the work item, {slug} its title."
        keywords={['branch', 'naming', 'template']}
        {...yamlRow(settings, 'branch')}
      >
        {config ? (
          <>
            <CommitInput
              label="Branch name pattern"
              value={config.branch}
              onDraft={setPattern}
              onCommit={(v) => void settings.set('branch', v)}
            />
            <div className="small muted">
              For User Story 1234 &ldquo;Add login page&rdquo;:{' '}
              <span className="mono">
                {renderBranch(shownPattern, EXAMPLE)}
              </span>
            </div>
          </>
        ) : (
          <Loading />
        )}
      </SettingRow>
      <SettingRow
        id="repo-general-connection"
        scope="repo"
        category="General"
        title="Connection"
        description="The Azure DevOps project this repo's work items come from."
        keywords={['Azure DevOps', 'project']}
      >
        <select
          className="field"
          aria-label={`Connection for ${repo.name}`}
          value={repo.connectionId ?? ''}
          onChange={async (e) => {
            const value = e.target.value || null;
            // repos:changed is broadcast by the handler and updates the store.
            await tryInvoke(
              () => api().invoke('repos:setConnection', repo.id, value),
              notify,
            );
          }}
        >
          <option value="">No connection</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} / {c.project}
            </option>
          ))}
        </select>
      </SettingRow>
      {repo.discovered && (
        <SettingRow
          id="repo-general-discovered"
          scope="repo"
          category="General"
          title="Found in a task"
          description="Shellie registered this repo because a task worked in it; Start never picks it."
          keywords={['discovered']}
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() =>
              tryInvoke(
                () => api().invoke('repos:setDiscovered', repo.id, false),
                notify,
              )
            }
          >
            Make it a normal repo
          </button>
        </SettingRow>
      )}
    </SettingsCategory>
  );
}

export function Loading() {
  return <div className="muted small">Loading&hellip;</div>;
}
