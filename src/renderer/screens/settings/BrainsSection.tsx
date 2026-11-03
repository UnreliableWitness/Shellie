import { useEffect, useId, useState } from 'react';
import type { BrainOptions, BrainView, BrainWiki } from '../../../shared/brain';
import type { Connection } from '../../../shared/types';
import { api } from '../../api';
import { WikiRootPicker } from '../../components/brain/WikiRootPicker';
import {
  SettingRow,
  SettingsCategory,
} from '../../components/settings/SettingRow';
import { useBrains } from '../../hooks/useBrains';
import { useStore } from '../../store';
import { track } from '../../telemetry';

type Action = 'create' | 'update' | 'delete' | 'update-skills' | 'open-folder';
const trackBrain = (action: Action) => track('settings.brain', { action });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const TOGGLES: {
  key: Exclude<keyof BrainOptions, 'dailyTokenCap' | 'model'>;
  label: string;
}[] = [
  {
    key: 'contextInTaskMd',
    label: "Add the brain's index to task.md when a task starts",
  },
  {
    key: 'addDirForClaude',
    label: "Give the task's Claude Code read access to the brain folder",
  },
  {
    key: 'syncAfterRefresh',
    label: 'Run /sync after a wiki refresh that changed pages',
  },
  {
    key: 'weeklyDigest',
    label: 'Write a weekly digest on Mondays while the app is open',
  },
  {
    key: 'openBrainTerminalOnStart',
    label: 'Open the brain terminal when a task starts',
  },
];

function CreateBrainForm({ connection }: { connection: Connection }) {
  const id = useId();
  const [name, setName] = useState(`${connection.project} brain`);
  const [project, setProject] = useState(connection.project);
  const [path, setPath] = useState<string | null>(null);
  const [wiki, setWiki] = useState<BrainWiki | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The picker queries Azure DevOps for this project, so it waits until typing pauses.
  const [settledProject, setSettledProject] = useState(connection.project);
  useEffect(() => {
    const t = setTimeout(() => setSettledProject(project.trim()), 400);
    return () => clearTimeout(t);
  }, [project]);

  const choose = async () => {
    try {
      const picked = await api().invoke('brain:pickFolder');
      if (picked) setPath(picked);
    } catch (e) {
      setError(message(e));
    }
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api().invoke('brain:create', {
        name: name.trim(),
        connectionId: connection.id,
        project: project.trim(),
        path,
        wiki,
      });
      trackBrain('create');
      setName(`${connection.project} brain`);
      setPath(null);
      setWiki(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="conn-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${id}-name`}>Name</label>
      <input
        id={`${id}-name`}
        className="field"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor={`${id}-project`}>Project</label>
      <input
        id={`${id}-project`}
        className="field"
        value={project}
        onChange={(e) => {
          setProject(e.target.value);
          setWiki(null);
        }}
      />
      <span id={`${id}-folder`}>Folder</span>
      <div className="row" aria-labelledby={`${id}-folder`}>
        <span className="mono small grow">{path ?? 'Default location'}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void choose()}
        >
          Choose…
        </button>
        {path ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setPath(null)}
          >
            Use default
          </button>
        ) : null}
      </div>
      <WikiRootPicker
        connectionId={connection.id}
        project={settledProject}
        value={wiki}
        onChange={setWiki}
        disabled={settledProject !== project.trim()}
      />
      {error ? (
        <div className="conn-status-bad" role="alert">
          {error}
        </div>
      ) : null}
      <div className="actions">
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={busy || !name.trim() || !project.trim()}
        >
          Create brain
        </button>
      </div>
    </form>
  );
}

function BrainCard({ brain }: { brain: BrainView }) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [diff, setDiff] = useState<
    { path: string; status: 'same' | 'changed' | 'missing' }[] | null
  >(null);
  const [confirming, setConfirming] = useState(false);
  const [withFolder, setWithFolder] = useState(false);
  const [busy, setBusy] = useState(false);

  /** One call at a time per card; `action` null: not counted (a read that is not the use itself). */
  const run = async (action: Action | null, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (action) trackBrain(action);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const update = (options: Partial<BrainOptions>) =>
    run('update', () => api().invoke('brain:update', brain.id, { options }));

  const commitCap = () => {
    const n = Number(cap);
    setCap(null);
    if (Number.isInteger(n) && n > 0 && n !== brain.options.dailyTokenCap)
      void update({ dailyTokenCap: n });
  };
  const toApply = (diff ?? [])
    .filter((d) => d.status !== 'same')
    .map((d) => d.path);

  return (
    <div className="list-row" style={{ display: 'block' }}>
      <div>
        <strong>{brain.name}</strong>{' '}
        <span className="small muted">{brain.project}</span>
      </div>
      <div className="mono small">{brain.path}</div>
      <div className="small muted">
        {brain.wiki
          ? `${brain.wiki.wikiName}, ${brain.wiki.rootPath === '/' ? 'whole wiki' : brain.wiki.rootPath}`
          : 'No wiki'}
      </div>
      {TOGGLES.map((t) => (
        <label key={t.key} className="row small">
          <input
            type="checkbox"
            checked={brain.options[t.key]}
            disabled={busy}
            onChange={(e) => void update({ [t.key]: e.target.checked })}
          />
          {t.label}
        </label>
      ))}
      <div className="row small">
        <label htmlFor={`${id}-cap`}>Daily token cap</label>
        <input
          id={`${id}-cap`}
          type="number"
          min={1}
          className="field"
          value={cap ?? brain.options.dailyTokenCap}
          disabled={busy}
          onChange={(e) => setCap(e.target.value)}
          onBlur={commitCap}
        />
        <label htmlFor={`${id}-model`}>Model</label>
        <select
          id={`${id}-model`}
          className="field"
          value={brain.options.model}
          disabled={busy}
          onChange={(e) =>
            void update({ model: e.target.value as BrainOptions['model'] })
          }
        >
          <option value="haiku">Haiku</option>
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
        </select>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            void run('open-folder', () =>
              api().invoke('brain:openFolder', brain.id),
            )
          }
        >
          Open folder
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            void run(null, async () =>
              setDiff(await api().invoke('brain:templateDiff', brain.id)),
            )
          }
        >
          Update skills
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setConfirming(true)}
        >
          Delete
        </button>
      </div>
      {diff ? (
        <div className="conn-confirm" role="status">
          {toApply.length === 0 ? (
            <span>Skills are up to date.</span>
          ) : (
            <ul>
              {diff.map((d) => (
                <li key={d.path}>
                  <span className="mono">{d.path}</span>{' '}
                  <span className="small muted">{d.status}</span>
                </li>
              ))}
            </ul>
          )}
          {toApply.length > 0 ? (
            <button
              type="button"
              className="btn btn-warn btn-sm"
              disabled={busy}
              onClick={() =>
                void run('update-skills', async () => {
                  await api().invoke(
                    'brain:updateTemplates',
                    brain.id,
                    toApply,
                  );
                  setDiff(null);
                })
              }
            >
              Apply
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setDiff(null)}
          >
            Close
          </button>
        </div>
      ) : null}
      {confirming ? (
        <div className="conn-confirm" role="status">
          <span>Delete this brain?</span>
          <label className="row small">
            <input
              type="checkbox"
              checked={withFolder}
              onChange={(e) => setWithFolder(e.target.checked)}
            />
            Also delete the folder
          </label>
          <button
            type="button"
            className="btn btn-warn btn-sm"
            disabled={busy}
            onClick={() =>
              void run('delete', () =>
                api().invoke('brain:delete', brain.id, withFolder),
              )
            }
          >
            Delete brain
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="conn-status-bad" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** Brains per Azure DevOps connection: create, configure, update skills, delete. */
export function BrainsSection() {
  const connections = useStore((s) => s.connections);
  const brains = useBrains();
  const ado = connections.filter((c) => c.provider === 'azure-devops');
  return (
    <SettingsCategory id="brains" title="Brains">
      {ado.length === 0 ? (
        <div className="small muted">Add a connection to create a brain.</div>
      ) : null}
      {ado.map((c) => (
        <SettingRow
          key={c.id}
          id={`brain-conn-${c.id}`}
          category="Brains"
          title={`${c.name} / ${c.project}`}
          description="Brains for this connection's project"
          keywords={['brain', 'wiki', 'second brain']}
        >
          <div className="list">
            {brains
              .filter((b) => b.connectionId === c.id)
              .map((b) => (
                <BrainCard key={b.id} brain={b} />
              ))}
          </div>
          <CreateBrainForm connection={c} />
        </SettingRow>
      ))}
    </SettingsCategory>
  );
}
