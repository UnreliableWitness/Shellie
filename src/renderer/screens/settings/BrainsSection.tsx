import { useEffect, useId, useRef, useState } from 'react';
import type { AgentsDetected } from '../../../shared/agents';
import {
  BRAIN_AGENT_LABELS,
  isOpencodeModel,
  opencodeReady,
  writeReady,
  type Brain,
  type BrainAgent,
  type BrainOptions,
  type BrainView,
  type BrainWiki,
} from '../../../shared/brain';
import type { Connection } from '../../../shared/types';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { defaultBrainAgent } from '../../brainAgent';
import { keeperElsewhere } from '../../components/brain/sharing';
import {
  asksHandOver,
  HandOverFirst,
  isMember,
  SharingControls,
} from '../../components/brain/SharingControls';
import { WikiRootPicker } from '../../components/brain/WikiRootPicker';
import { useReaderStatus } from '../../components/PhoneSection';
import { useBrains } from '../../hooks/useBrains';
import { useStore } from '../../store';
import { track } from '../../telemetry';

type Action =
  | 'create'
  | 'update'
  | 'delete'
  | 'update-skills'
  | 'open-folder'
  | 'archive'
  | 'restore';
const trackBrain = (action: Action, field?: 'agent' | 'opencodeModel') =>
  track('settings.brain', field ? { action, field } : { action });

const TOGGLES: {
  key: Exclude<
    keyof BrainOptions,
    'dailyTokenCap' | 'model' | 'agent' | 'opencodeModel'
  >;
  label: string;
}[] = [
  {
    key: 'contextInTaskMd',
    label: "Add the brain's index to task.md when a task starts",
  },
  {
    key: 'addDirForClaude',
    label: "Give the task's agent read access to the brain folder",
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
    key: 'writeLongReads',
    label: 'Write long reads in the background, at most two a day',
  },
  {
    key: 'sendToPhone',
    label: 'Send long reads and letters to my phone',
  },
  {
    key: 'openBrainTerminalOnStart',
    label: 'Open the brain terminal when a task starts',
  },
];

/** The section a deep link ("+ New brain" on the project page) opens with this form focused. */
export const NEW_BRAIN_SECTION = 'project-brains-new';

const BRAIN_AGENTS: BrainAgent[] = ['claude', 'opencode'];
const NO_AGENT_NOTE =
  "Neither Claude Code nor OpenCode was found on this machine; the brain's jobs will fail until one is installed.";

/** The create form; `onCreated` runs after a brain was created (the onboarding page embeds this form). */
export function CreateBrainForm({
  connection,
  focus,
  onCreated,
}: {
  connection: Connection;
  /** Changes (a new deep link) to focus the name field again; null leaves focus alone. */
  focus: object | null;
  onCreated?: (brain: Brain) => void;
}) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) nameRef.current?.focus({ preventScroll: true });
  }, [focus]);
  const [name, setName] = useState(`${connection.project} brain`);
  const [project, setProject] = useState(connection.project);
  const [path, setPath] = useState<string | null>(null);
  const [wiki, setWiki] = useState<BrainWiki | null>(null);
  const [detected, setDetected] = useState<AgentsDetected | null>(null);
  const [picked, setPicked] = useState<BrainAgent | null>(null);
  useEffect(() => {
    let live = true;
    api()
      .invoke('agents:detect', false)
      .then((d) => live && setDetected(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const fallback = defaultBrainAgent(detected);
  const agent = picked ?? fallback.agent;
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
      setError(errorMessage(e));
    }
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api().invoke('brain:create', {
        name: name.trim(),
        connectionId: connection.id,
        project: project.trim(),
        path,
        wiki,
        agent,
      });
      trackBrain('create');
      setName(`${connection.project} brain`);
      setPath(null);
      setWiki(null);
      onCreated?.(created);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      id={NEW_BRAIN_SECTION}
      className="conn-form"
      aria-label="New brain"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${id}-name`}>Name</label>
      <input
        ref={nameRef}
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
      <label htmlFor={`${id}-agent`}>Agent</label>
      <select
        id={`${id}-agent`}
        className="field"
        value={agent}
        onChange={(e) => setPicked(e.target.value as BrainAgent)}
      >
        {BRAIN_AGENTS.map((a) => (
          <option key={a} value={a}>
            {BRAIN_AGENT_LABELS[a]}
            {detected
              ? detected.agents[a].found
                ? ' (found)'
                : ' (not found)'
              : ''}
          </option>
        ))}
      </select>
      {detected && !fallback.found ? (
        <div className="small muted">{NO_AGENT_NOTE}</div>
      ) : null}
      <span id={`${id}-folder`} className="conn-label">
        Folder
      </span>
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

/** The OpenCode model: a select of the models `opencode models` lists, or a text field when the list cannot be read. */
function OpenCodeModelControl({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: string | null;
  disabled: boolean;
  onChange: (model: string | null) => void;
}) {
  // undefined: still reading; null: could not be read.
  const [models, setModels] = useState<string[] | null | undefined>(undefined);
  const [typed, setTyped] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api()
      .invoke('agents:opencodeModels')
      .then((m) => live && setModels(m))
      .catch(() => live && setModels(null));
    return () => {
      live = false;
    };
  }, []);
  if (models === null) {
    // It reaches OpenCode's command line as `-m`: anything but a plain provider/model stays unsaved.
    const invalid =
      (typed ?? '').trim() !== '' && !isOpencodeModel(typed!.trim());
    const commit = () => {
      const next = (typed ?? value ?? '').trim() || null;
      if (next !== null && !isOpencodeModel(next)) return;
      setTyped(null);
      if (next !== value) onChange(next);
    };
    return (
      <>
        <input
          id={id}
          className="field"
          placeholder="provider/model"
          value={typed ?? value ?? ''}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={commit}
        />
        {invalid ? (
          <span className="small muted">
            Use provider/model, without spaces or quotes
          </span>
        ) : null}
      </>
    );
  }
  const listed = models ?? [];
  return (
    <select
      id={id}
      className="field"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">OpenCode's default</option>
      {value && !listed.includes(value) ? (
        <option value={value}>{value}</option>
      ) : null}
      {listed.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

function BrainCard({ brain }: { brain: BrainView }) {
  const [phone] = useReaderStatus();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [diff, setDiff] = useState<
    { path: string; status: 'same' | 'changed' | 'missing' }[] | null
  >(null);
  const [confirming, setConfirming] = useState(false);
  const [withFolder, setWithFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The keeper's Archive or Delete waiting on the hand-over question. */
  const [asking, setAsking] = useState<'archive' | 'delete' | null>(null);

  /** One call at a time per card; `action` null: not counted (a read that is not the use itself). */
  const run = async (
    action: Action | null,
    fn: () => Promise<unknown>,
    field?: 'agent' | 'opencodeModel',
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (action) trackBrain(action, field);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const update = (options: Partial<BrainOptions>) =>
    run(
      'update',
      () => api().invoke('brain:update', brain.id, { options }),
      'agent' in options
        ? 'agent'
        : 'opencodeModel' in options
          ? 'opencodeModel'
          : undefined,
    );

  const commitCap = () => {
    const n = Number(cap);
    setCap(null);
    if (Number.isInteger(n) && n > 0 && n !== brain.options.dailyTokenCap)
      void update({ dailyTokenCap: n });
  };
  const archive = () =>
    run(brain.archived ? 'restore' : 'archive', () =>
      api().invoke('brain:update', brain.id, {
        archived: !brain.archived,
      }),
    );
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
      {TOGGLES.filter(
        // A switch that does nothing is not offered: until the skills are updated, or without a phone connected
        // (one that is on stays, so it can be switched off).
        (t) =>
          (t.key !== 'writeLongReads' || writeReady(brain)) &&
          (t.key !== 'sendToPhone' ||
            phone?.connected === true ||
            brain.options.sendToPhone),
      ).map((t) =>
        keeperElsewhere(brain) &&
        (t.key === 'syncAfterRefresh' ||
          t.key === 'weeklyDigest' ||
          t.key === 'writeLongReads') ? (
          <div key={t.key} className="row small">
            <span>{t.label}</span>
            <span className="muted">
              Runs on {keeperElsewhere(brain)}&apos;s Shellie
            </span>
          </div>
        ) : (
          <label key={t.key} className="row small">
            <input
              type="checkbox"
              checked={brain.options[t.key]}
              disabled={busy}
              onChange={(e) => void update({ [t.key]: e.target.checked })}
            />
            {t.label}
          </label>
        ),
      )}
      <SharingControls brain={brain} />
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
        <label htmlFor={`${id}-agent`}>Agent</label>
        <select
          id={`${id}-agent`}
          className="field"
          value={brain.options.agent}
          disabled={busy}
          onChange={(e) => void update({ agent: e.target.value as BrainAgent })}
        >
          {BRAIN_AGENTS.map((a) => (
            <option key={a} value={a}>
              {BRAIN_AGENT_LABELS[a]}
            </option>
          ))}
        </select>
        {brain.options.agent === 'opencode' && !opencodeReady(brain) ? (
          <span className="small muted">Update skills first</span>
        ) : null}
        <label htmlFor={`${id}-model`}>Model</label>
        {brain.options.agent === 'opencode' ? (
          <OpenCodeModelControl
            id={`${id}-model`}
            value={brain.options.opencodeModel}
            disabled={busy}
            onChange={(opencodeModel) => void update({ opencodeModel })}
          />
        ) : (
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
        )}
      </div>
      {brain.options.agent === 'opencode' ? (
        <div className="small muted">
          Pictures are read only by models that can see images.
        </div>
      ) : null}
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
        {/* A member leaves instead (Leave, above): their line goes from the members list first. */}
        {!isMember(brain) && (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                !brain.archived && asksHandOver(brain)
                  ? setAsking('archive')
                  : void archive()
              }
            >
              {brain.archived ? 'Restore' : 'Archive'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                asksHandOver(brain) ? setAsking('delete') : setConfirming(true)
              }
            >
              Delete
            </button>
          </>
        )}
      </div>
      {asking ? (
        <HandOverFirst
          brain={brain}
          anyway={asking === 'archive' ? 'Archive anyway' : 'Delete anyway'}
          onAnyway={() => {
            setAsking(null);
            if (asking === 'archive') void archive();
            else setConfirming(true);
          }}
          onCancel={() => setAsking(null)}
        />
      ) : null}
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
          {toApply.length > 0 && brain.sharing ? (
            <span className="small">
              This brain is shared: applying updates the skills for everyone who
              shares it.
            </span>
          ) : null}
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

/** One project's brains: active ones, archived ones apart, and the form to create one. */
export function BrainsForConnection({
  connection,
}: {
  connection: Connection;
}) {
  const brains = useBrains().filter((b) => b.connectionId === connection.id);
  const focusNew = useStore((s) =>
    s.screen.kind === 'settings' && s.screen.section === NEW_BRAIN_SECTION
      ? s.screen
      : null,
  );
  const archived = brains.filter((b) => b.archived);
  return (
    <>
      <div className="list">
        {brains
          .filter((b) => !b.archived)
          .map((b) => (
            <BrainCard key={b.id} brain={b} />
          ))}
      </div>
      {archived.length > 0 && (
        <div className="list" aria-label="Archived brains">
          <div className="muted small">
            Archived: out of the nav, no task gets them, nothing runs for them.
            Restore to use again.
          </div>
          {archived.map((b) => (
            <BrainCard key={b.id} brain={b} />
          ))}
        </div>
      )}
      <CreateBrainForm connection={connection} focus={focusNew} />
    </>
  );
}
