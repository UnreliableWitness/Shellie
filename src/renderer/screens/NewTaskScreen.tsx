import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultEditorPrefs, type EditorPrefs } from '../../shared/editors';
import { renderBranch, taskSlug } from '../../shared/naming';
import { buildSetupSummary, setupTabLabels } from '../../shared/setupSummary';
import { setupTabsFrom } from '../../shared/terminals';
import type {
  CopyEntry,
  ShellieConfig,
  WorkItemRef,
  WorkItemType,
} from '../../shared/types';
import {
  ENVIRONMENT_LABEL,
  ENVIRONMENTS,
  type Environment,
  type GivenTo,
  isGuarded,
} from '../../shared/secrets';
import { api, tryInvoke } from '../api';
import { EnvironmentConfirm } from '../components/secrets/EnvironmentChip';
import { TaskSummaryCard } from '../components/TaskSummaryCard';
import { PageHeader, Pivots, WorkItemTypeIcon } from '../components/ui';
import { WorkItemPicker } from '../components/WorkItemPicker';
import { useEscape } from '../hooks/useEscape';
import { effectiveStartSettings } from '../../shared/startSettings';
import { activeConnection, useStore } from '../store';
import { useTypeMeta } from '../workItemTypes';

type Mode = 'pick' | 'typed' | 'blank';
const TYPES: WorkItemType[] = ['Issue', 'User Story', 'Bug', 'Task', 'Epic'];

/** Opening New task from a sprint row passes the work item and its repo. */
export function NewTaskScreen({
  initial = {},
}: {
  initial?: {
    workItem?: WorkItemRef;
    repoId?: string;
    connectionId?: string;
  };
}) {
  const repos = useStore((s) => s.repos);
  const go = useStore((s) => s.go);
  const back = useStore((s) => s.back);
  const select = useStore((s) => s.select);
  const notify = useStore((s) => s.notify);
  const connections = useStore((s) => s.connections);
  const active = useStore(activeConnection);
  // The active project's repos (and repos linked to none), never another project's (#225); a sprint row's own
  // repo always stays.
  const projectId = initial.connectionId ?? active?.id;
  const candidates = repos.filter(
    (r) =>
      !projectId ||
      r.id === initial.repoId ||
      r.connectionId === projectId ||
      r.connectionId === null,
  );

  // '' is No repo: a task in a scratch folder, for working with the project's brain.
  const [repoId, setRepoId] = useState(
    candidates.find((r) => r.id === initial.repoId)?.id ??
      candidates[0]?.id ??
      '',
  );
  const noRepo = repoId === '';
  const connectionOf = (rid: string) => {
    const cid = repos.find((x) => x.id === rid)?.connectionId;
    return cid ? (connections.find((c) => c.id === cid) ?? null) : null;
  };
  const [rawMode, setMode] = useState<Mode>(() =>
    connectionOf(repoId) ? 'pick' : 'typed',
  );
  const modeChosen = useRef(false);
  const lastRepo = useRef(repoId);
  const lastConnection = useRef<string | null>(
    connectionOf(repoId)?.id ?? null,
  );
  const [picked, setPicked] = useState<WorkItemRef | null>(
    initial.workItem ?? null,
  );
  useEscape(back);
  const [config, setConfig] = useState<{
    config: ShellieConfig;
    worktreeRoot: string;
    fileError: string | null;
  } | null>(null);
  const [id, setId] = useState('');
  const [type, setType] = useState<WorkItemType>('User Story');
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const [baseRef, setBaseRef] = useState('');
  // A hand-typed branch; null follows the repo's template.
  const [editedBranch, setEditedBranch] = useState<string | null>(null);
  const [copy, setCopy] = useState(true);
  const [commands, setCommands] = useState<Record<string, boolean>>({});
  // The tabs to open, pre-ticked from Settings > Terminals and agents once they load.
  const [startClaude, setStartClaude] = useState(true);
  const [openShell, setOpenShell] = useState(true);
  const [openCopilot, setOpenCopilot] = useState(false);
  const [openOpencode, setOpenOpencode] = useState(false);
  // The repo's default once it loads; UAT and Production ask before the task is created.
  const [environment, setEnvironment] = useState<Environment>('development');
  const [asking, setAsking] = useState(false);
  const [askKeys, setAskKeys] = useState<string[] | null>(null);
  /** The tabs the confirm names: only those a stored value for the environment goes into. */
  const [askTabs, setAskTabs] = useState<string[]>([]);
  const [productionMinutes, setProductionMinutes] = useState<number | null>(
    null,
  );
  const [editorPrefs, setEditorPrefs] =
    useState<EditorPrefs>(defaultEditorPrefs);
  const [copyStates, setCopyStates] = useState<CopyEntry[] | undefined>();
  useEffect(() => {
    let live = true;
    void tryInvoke(() => api().invoke('settings:get'), notify).then((s) => {
      if (!live || !s) return;
      setProductionMinutes(s.secrets.productionMinutes);
      setEditorPrefs(s.editor);
      const tabs = setupTabsFrom(s.defaultTerminals);
      setStartClaude(tabs.startClaude);
      setOpenShell(tabs.openShell);
      setOpenCopilot(tabs.openCopilot);
      setOpenOpencode(tabs.openOpencode);
    });
    return () => {
      live = false;
    };
  }, [notify]);
  const [busy, setBusy] = useState(false);

  const repo = repos.find((r) => r.id === repoId) ?? null;
  const connection = connectionOf(repoId);
  const connectionId = connection?.id ?? null;
  // A task without a repo has a name only, like Blank.
  const mode: Mode = noRepo
    ? 'blank'
    : rawMode === 'pick' && !connection
      ? 'typed'
      : rawMode;

  useEffect(() => {
    const repoChanged = lastRepo.current !== repoId;
    lastRepo.current = repoId;
    const connectionChanged = lastConnection.current !== connectionId;
    lastConnection.current = connectionId;
    if (repoChanged) modeChosen.current = false;
    // A pick belongs to one connection; drop it when that changes, keep it for another repo on the same one.
    if (connectionChanged) setPicked(null);
    setMode((m) =>
      connectionId
        ? repoChanged || !modeChosen.current
          ? 'pick'
          : m
        : m === 'pick'
          ? 'typed'
          : m,
    );
  }, [repoId, connectionId]);

  useEffect(() => {
    if (!repoId) return;
    let live = true;
    setConfig(null);
    setCopyStates(undefined);
    setBaseRef('');
    setCopy(true);
    setCommands({});
    setEditedBranch(null);
    setEnvironment('development');
    setAsking(false);
    void tryInvoke(
      () => api().invoke('secrets:repoDefault', repoId),
      notify,
    ).then((env) => {
      if (live && env) setEnvironment(isGuarded(env) ? 'development' : env);
    });
    void tryInvoke(
      () => api().invoke('repos:copyEntries', repoId),
      notify,
    ).then((result) => {
      if (live && result) setCopyStates(result.entries);
    });
    void tryInvoke(() => api().invoke('repos:config', repoId), notify).then(
      (result) => {
        if (!live || !result) return;
        setConfig(result);
        setBaseRef(`origin/${result.config.base}`);
        setCommands(
          Object.fromEntries(result.config.setup.map((c) => [c, true])),
        );
      },
    );
    return () => {
      live = false;
    };
  }, [repoId, notify]);

  const changeMode = (next: Mode) => {
    modeChosen.current = true;
    setMode(next);
    setEditedBranch(null);
  };

  const workItem: WorkItemRef | null = useMemo(
    () =>
      mode === 'pick'
        ? picked
        : mode === 'typed' && (id.trim() || title.trim())
          ? {
              id: id.trim(),
              type,
              title: title.trim(),
              url: null,
              project: null,
            }
          : null,
    [mode, picked, id, type, title],
  );
  const label =
    mode === 'blank'
      ? name
      : (workItem?.title ?? (mode === 'typed' ? title : ''));
  const template = config?.config.branch ?? '{type}/{id}-{slug}';

  const branch =
    editedBranch ??
    (label.trim() || workItem?.id
      ? renderBranch(template, { workItem, name })
      : '');

  const slug =
    label.trim() || workItem?.id
      ? taskSlug(workItem && workItem.id ? workItem : null, label)
      : '...';
  const folder = config ? `${config.worktreeRoot}/${slug}` : '';
  const baseOptions = config
    ? [`origin/${config.config.base}`, config.config.base]
    : [];

  const typeMeta = useTypeMeta(
    connectionId,
    workItem?.id ? workItem.type : null,
  );
  const chosenCommands = (config?.config.setup ?? []).filter(
    (c) => commands[c],
  );
  /** What the task will get, live from the form and the repo's current settings. */
  const summary =
    repo && config
      ? buildSetupSummary({
          repoId: repo.id,
          branch,
          base: baseRef,
          config: config.config,
          copy,
          commands: chosenCommands,
          tabs: setupTabLabels(
            { startClaude, openShell, openCopilot, openOpencode },
            'Shell',
          ),
          workItem: mode === 'blank' || !workItem?.id ? null : workItem,
          start: effectiveStartSettings(repo, connectionOf(repo.id)),
          types: typeMeta ? [typeMeta] : null,
          editor: editorPrefs,
          // Main fills it in when the task is created.
          brain: null,
        })
      : null;

  const canCreate =
    mode === 'pick'
      ? picked !== null
      : mode === 'typed'
        ? Boolean(id.trim() && title.trim())
        : Boolean(name.trim());

  /** The tabs setup opens that can hold secrets, as the confirm names them. */
  const setupTabs = [
    ...((config?.config.setup ?? []).some((c) => commands[c]) ? ['Setup'] : []),
    ...(openShell ? ['your shell'] : []),
  ];

  const createWithoutRepo = async () => {
    setBusy(true);
    const task = await tryInvoke(
      () =>
        api().invoke('tasks:create', {
          repoId: null,
          connectionId: active?.id ?? null,
          baseRef: '',
          name,
          workItem: null,
          branch: '',
          copy: false,
          commands: [],
          startClaude,
          openShell,
          openCopilot,
          openOpencode,
        }),
      notify,
    );
    setBusy(false);
    if (task) {
      select(task.id);
      go({ kind: 'setup', taskId: task.id });
    }
  };

  const create = async (confirmed = false) => {
    if (busy) return;
    if (noRepo) return createWithoutRepo();
    if (!repo) return notify('error', 'Add a repository in Settings first');
    if (isGuarded(environment) && !confirmed) {
      setAsking(true);
      setAskKeys(null);
      setAskTabs([]);
      const env = environment;
      // Only names that reach a tab setup opens, as the task bar's confirm lists them.
      const given = new Set<GivenTo>([
        ...(setupTabs.includes('Setup') ? (['setup'] as const) : []),
        ...(openShell ? (['shell'] as const) : []),
      ]);
      void tryInvoke(() => api().invoke('secrets:list', repo.id), notify).then(
        (list) => {
          if (!list) return;
          const reaching = list.filter(
            (v) => v.values[env] && v.givenTo.some((g) => given.has(g)),
          );
          const gets = (g: GivenTo) =>
            reaching.some((v) => v.givenTo.includes(g));
          setAskTabs([
            ...(given.has('setup') && gets('setup') ? ['Setup'] : []),
            ...(given.has('shell') && gets('shell') ? ['your shell'] : []),
          ]);
          setAskKeys([...new Set(reaching.map((v) => v.name))]);
        },
      );
      return;
    }
    setAsking(false);
    setBusy(true);
    const task = await tryInvoke(
      () =>
        api().invoke('tasks:create', {
          repoId: repo.id,
          baseRef,
          name: mode === 'blank' ? name : '',
          workItem:
            mode === 'blank' ? null : workItem && workItem.id ? workItem : null,
          branch,
          copy,
          commands: chosenCommands,
          startClaude,
          openShell,
          openCopilot,
          openOpencode,
          environment,
          ...(confirmed ? { environmentConfirmed: true } : {}),
        }),
      notify,
    );
    setBusy(false);
    if (task) {
      select(task.id);
      go({ kind: 'setup', taskId: task.id });
    }
  };

  const pivots: { key: Mode; label: string }[] = [
    ...(connection && !noRepo
      ? [{ key: 'pick' as const, label: 'Work item' }]
      : []),
    ...(noRepo ? [] : [{ key: 'typed' as const, label: 'Typed' }]),
    { key: 'blank', label: 'Blank' },
  ];

  return (
    <div className="page page-newtask">
      <PageHeader
        title="New task"
        pivots={
          <Pivots
            label="Start from"
            items={pivots}
            selected={mode}
            onSelect={changeMode}
          />
        }
      />
      <div className="newtask">
        <section
          className="newtask-main"
          aria-label={mode === 'blank' ? 'Task' : 'Work item'}
        >
          {mode === 'pick' && connection ? (
            <WorkItemPicker
              key={connection.id}
              connectionId={connection.id}
              selectedId={picked?.id ?? null}
              onPick={setPicked}
            />
          ) : mode === 'typed' ? (
            <div className="form-stack">
              <label>
                Work item id
                <input
                  className="field mono"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                />
              </label>
              <label>
                Type
                <select
                  className="field"
                  value={type}
                  onChange={(e) => setType(e.target.value as WorkItemType)}
                >
                  {TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label>
                Title
                <input
                  className="field"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
            </div>
          ) : (
            <div className="form-stack">
              <label>
                Task name
                <input
                  className="field"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            </div>
          )}
        </section>
        <section className="newtask-details" aria-label="Task preview">
          <div>
            <div className="muted small newtask-preview-type">
              {workItem?.id && (
                <WorkItemTypeIcon
                  type={workItem.type}
                  connectionId={connectionId}
                  size={14}
                />
              )}
              {workItem?.id ? `${workItem.type} ${workItem.id}` : 'Blank task'}
            </div>
            <div className="newtask-preview-title">{label || 'New task'}</div>
          </div>
          <div className="form-grid">
            <label htmlFor="nt-repo">Repo</label>
            <select
              id="nt-repo"
              className="field"
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
            >
              {candidates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
              <option value="">No repo</option>
            </select>
            {noRepo && (
              <p className="muted small form-grid-full">
                A folder of its own with terminals and the project&apos;s brain:
                no branch, no changes to review, no pull request.
              </p>
            )}
            {!noRepo && config?.fileError != null && (
              // A task never starts on a broken file's defaults: Create stays off until it is fixed.
              <p className="text-red small form-grid-full" role="alert">
                {config.fileError}
              </p>
            )}
            {!noRepo && (
              <>
                <label htmlFor="nt-base">From</label>
                <select
                  id="nt-base"
                  className="field mono"
                  value={baseRef}
                  onChange={(e) => setBaseRef(e.target.value)}
                >
                  {baseOptions.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
                <label htmlFor="nt-branch">Branch</label>
                <input
                  id="nt-branch"
                  className="field mono"
                  value={branch}
                  onChange={(e) => setEditedBranch(e.target.value)}
                  onBlur={(e) => {
                    if (!e.target.value) setEditedBranch(null);
                  }}
                />
                <span className="label">Folder</span>
                <span
                  className="mono small"
                  style={{ overflowWrap: 'anywhere' }}
                >
                  {folder}
                </span>
                <label htmlFor="nt-env">Environment</label>
                <select
                  id="nt-env"
                  className="field"
                  value={environment}
                  onChange={(e) => {
                    setEnvironment(e.target.value as Environment);
                    setAsking(false);
                  }}
                >
                  {ENVIRONMENTS.map((e) => (
                    <option key={e} value={e}>
                      {ENVIRONMENT_LABEL[e]}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          {!noRepo && summary && repo && (
            <TaskSummaryCard
              summary={summary}
              repoId={repo.id}
              copyStates={copyStates}
            />
          )}
          {!noRepo && (
            <fieldset className="group">
              <legend>Setup from .shellie.yml</legend>
              {config && config.config.copy.length > 0 && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={copy}
                    onChange={(e) => setCopy(e.target.checked)}
                  />
                  Copy{' '}
                  <span className="mono small">
                    {config.config.copy.join(', ')}
                  </span>
                </label>
              )}
              {(config?.config.setup ?? []).map((c) => (
                <label key={c} className="checkbox">
                  <input
                    type="checkbox"
                    checked={commands[c] ?? false}
                    onChange={(e) => {
                      const { checked } = e.target;
                      setCommands((prev) => ({ ...prev, [c]: checked }));
                    }}
                  />
                  <span className="mono">{c}</span>
                </label>
              ))}
              {(config?.config.setup.length ?? 0) > 0 && (
                <span className="muted small">
                  Commands run in a Setup tab while you work.
                </span>
              )}
              {config &&
                config.config.setup.length === 0 &&
                config.config.copy.length === 0 && (
                  <span className="muted small">
                    Nothing to run for this repo.
                  </span>
                )}
            </fieldset>
          )}
          <fieldset className="group">
            <legend>When ready</legend>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={startClaude}
                onChange={(e) => setStartClaude(e.target.checked)}
              />
              Open Claude Code with the task loaded (it waits for you)
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={openShell}
                onChange={(e) => setOpenShell(e.target.checked)}
              />
              Open a shell tab
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={openCopilot}
                onChange={(e) => setOpenCopilot(e.target.checked)}
              />
              Start Copilot CLI with the task
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={openOpencode}
                onChange={(e) => setOpenOpencode(e.target.checked)}
              />
              Start OpenCode with the task
            </label>
          </fieldset>
          {asking && isGuarded(environment) && (
            <EnvironmentConfirm
              title={`Start ${(workItem?.id || label.trim() || 'this task').trim()} on ${ENVIRONMENT_LABEL[environment]}?`}
              env={environment as 'uat' | 'production'}
              tabs={askTabs}
              keys={askKeys}
              minutes={productionMinutes}
              busy={busy}
              onCancel={() => setAsking(false)}
              onConfirm={() => void create(true)}
            />
          )}
          <div className="actions">
            <button type="button" className="btn" onClick={back}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                noRepo
                  ? busy || !canCreate
                  : busy ||
                    !repo ||
                    !config ||
                    config.fileError !== null ||
                    !baseRef ||
                    !branch ||
                    !canCreate
              }
              onClick={() => void create()}
            >
              Create task
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
