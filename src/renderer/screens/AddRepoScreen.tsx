import { useEffect, useRef, useState } from 'react';
import { parse as parseYaml } from 'yaml';
import type { RepoInspection } from '../../shared/repoInspection';
import { ShellieYmlSchema } from '../../shared/shellieYml';
import { api, ipcErrorMessage, tryInvoke } from '../api';
import { PageHeader, StepStrip } from '../components/ui';
import { nextStep, stepsFrom } from '../onboardingState';
import { useStore } from '../store';
import { track } from '../telemetry';

/** null when the text is a valid `.shellie.yml`, else what is wrong with it. */
function yamlProblem(text: string): string | null {
  try {
    const result = ShellieYmlSchema.safeParse(parseYaml(text) ?? {});
    if (result.success) return null;
    const issue = result.error.issues[0];
    const where = issue?.path.join('.');
    return `${where ? `${where}: ` : ''}${issue?.message ?? 'Not a valid .shellie.yml'}`;
  } catch (e) {
    return ipcErrorMessage(e);
  }
}

const LOCKFILES = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
} as const;

function Code({ children }: { children: string }) {
  return <code className="chip-code">{children}</code>;
}

function Facts({ found }: { found: RepoInspection }) {
  const f = found.facts;
  const stack = [f.lockfile ? LOCKFILES[f.lockfile] : null, ...f.dotnet].filter(
    (x): x is string => !!x,
  );
  const rows: { label: string; value: React.ReactNode; note?: string }[] = [
    {
      label: 'Remote',
      value: found.remote?.url ?? 'No remote',
      note: !found.remote
        ? 'tasks work without a tracker'
        : found.remote.provider === 'azure-devops'
          ? found.remote.connectionId
            ? `Linked to project ${found.remote.project ?? ''}`
            : 'Not linked: add a connection for this organization'
          : undefined,
    },
    { label: 'Base branch', value: <Code>{found.baseBranch}</Code> },
    {
      label: 'Stack',
      value: stack.length
        ? stack.map((s) => <Code key={s}>{s}</Code>)
        : 'None found',
    },
    {
      label: 'Scripts',
      value: f.devScript ? (
        <Code>{`"${f.devScript}" in package.json`}</Code>
      ) : (
        'None found'
      ),
      note: f.devScript ? 'kept in .shellie.yml for later' : undefined,
    },
    {
      label: 'Agent packages',
      value: f.apm ? <Code>apm.yml</Code> : 'None found',
      note: f.apm ? 'installed per task, ticked agents only' : undefined,
    },
    {
      label: 'Env files',
      value: f.envFiles.length
        ? f.envFiles.map((e) => <Code key={e}>{e}</Code>)
        : 'None found',
      note: f.envFiles.length ? 'copied into each worktree' : undefined,
    },
  ];
  return (
    <div className="repo-facts">
      <h3>What Shellie found</h3>
      {rows.map((r) => (
        <div className="repo-fact" key={r.label}>
          <span className="muted">{r.label}</span>
          <span className="repo-fact-value">{r.value}</span>
          <span className="small muted">
            {r.note &&
              (r.note.startsWith('Linked') ? (
                <span className="pill-ok">{r.note}</span>
              ) : (
                r.note
              ))}
          </span>
        </div>
      ))}
    </div>
  );
}

export function AddRepoScreen({ folder: initial }: { folder?: string }) {
  const screen = useStore((s) => s.screen);
  const go = useStore((s) => s.go);
  const back = useStore((s) => s.back);
  const notify = useStore((s) => s.notify);
  const from = screen.kind === 'add-repo' ? screen.from : 'settings';
  const onboarding = from === 'get-started';

  const [folder, setFolder] = useState(initial ?? '');
  const [found, setFound] = useState<RepoInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [write, setWrite] = useState(true);
  const [busy, setBusy] = useState(false);

  const latest = useRef(0);
  const inspect = async (path: string) => {
    const id = ++latest.current;
    setFolder(path);
    setFound(null);
    setError(null);
    setEditing(false);
    try {
      const result = await api().invoke('repos:inspect', path);
      if (id !== latest.current) return;
      setFound(result);
      setText(result.proposal ?? '');
    } catch (e) {
      if (id === latest.current) setError(ipcErrorMessage(e));
    }
  };

  useEffect(() => {
    if (initial) void inspect(initial);
    // Inspect the folder the page opened with, once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const browse = async () => {
    const picked = await tryInvoke(
      () => api().invoke('repos:pickFolder'),
      notify,
    );
    if (picked) await inspect(picked);
  };

  const hasProposal = !!found?.proposal;
  const problem = hasProposal && write ? yamlProblem(text) : null;
  const canAdd = !!found && !problem && !busy;

  const leave = () =>
    from === 'settings' ? go({ kind: 'settings', scope: 'repo' }) : back();

  const goBack = () => {
    if (onboarding)
      track('onboarding.step', { step: 'repository', outcome: 'back' });
    leave();
  };

  /** Adds the repo; then, with `importSecrets`, opens the Import page for the secrets Shellie found. */
  const add = async (importSecrets = false) => {
    if (!found) return;
    setBusy(true);
    const added = await tryInvoke(
      () =>
        api().invoke('repos:add', found.folder, {
          ...(hasProposal && write ? { writeConfig: text } : {}),
          baseBranch: found.baseBranch,
          connectionId:
            found.remote?.connectionId ??
            (screen.kind === 'add-repo' ? screen.connectionId : undefined) ??
            null,
        }),
      notify,
    );
    setBusy(false);
    if (!added) return;
    api()
      .invoke('repos:list')
      .then((r) => useStore.getState().setRepos(r))
      .catch(() => undefined);
    if (onboarding)
      track('onboarding.step', { step: 'repository', outcome: 'continued' });
    if (importSecrets) go({ kind: 'secrets-import', repoId: added.id });
    else if (onboarding) {
      go(
        nextStep(
          stepsFrom({ ...useStore.getState(), repos: [added] }),
          'repository',
        ),
      );
    } else go({ kind: 'settings', repoId: added.id });
  };

  return (
    <div className="page">
      {onboarding && <StepStrip current="repository" />}
      <PageHeader title="Add a repository" />
      <div className="page-body add-repo">
        <p className="muted">
          Shellie reads the folder and proposes how tasks in it start.
        </p>
        <div className="add-repo-grid">
          <div className="card add-repo-left">
            <div className="repo-fact">
              <label htmlFor="add-repo-folder" className="muted">
                Folder
              </label>
              <input
                id="add-repo-folder"
                className="field"
                value={folder}
                onChange={(e) => {
                  setFolder(e.target.value);
                  if (e.target.value !== found?.folder) {
                    latest.current++;
                    setFound(null);
                    setError(null);
                    setEditing(false);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && folder) void inspect(folder);
                }}
                onBlur={() => {
                  if (folder && folder !== found?.folder) void inspect(folder);
                }}
              />
              <button type="button" className="btn" onClick={browse}>
                Browse&hellip;
              </button>
            </div>
            {error && (
              <p className="add-repo-error" role="alert">
                {error}
              </p>
            )}
            {found && <Facts found={found} />}
            {found && (found.secretsFound ?? 0) > 0 && (
              <div className="repo-fact add-repo-secrets">
                <span className="muted">Secrets</span>
                <span className="repo-fact-value">
                  {found.secretsFound === 1
                    ? '1 secret found'
                    : `${found.secretsFound} secrets found`}
                </span>
                <button
                  type="button"
                  className="link"
                  disabled={!canAdd}
                  onClick={() => void add(true)}
                >
                  Add and import them
                </button>
              </div>
            )}
          </div>
          {found && (
            <div className="add-repo-right">
              <div className="section-head">
                <h3>
                  {hasProposal
                    ? 'Proposed .shellie.yml'
                    : 'Existing .shellie.yml'}
                </h3>
                {hasProposal && write && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => setEditing((e) => !e)}
                  >
                    {editing ? 'Done' : 'Edit'}
                  </button>
                )}
              </div>
              {editing && hasProposal ? (
                <textarea
                  className="field add-repo-yml"
                  aria-label="Proposed .shellie.yml"
                  spellCheck={false}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              ) : (
                <pre className="add-repo-code">
                  {hasProposal ? text : (found.facts.existing ?? '')}
                </pre>
              )}
              {problem && (
                <p className="add-repo-error" role="alert">
                  {problem}
                </p>
              )}
              {!hasProposal && (
                <p className="small muted">
                  This repository already has a .shellie.yml. Shellie uses it as
                  it is.
                </p>
              )}
              {found.remote?.provider === 'github' && (
                <p className="add-repo-note small">
                  <strong>A GitHub remote?</strong> Shellie links it once GitHub
                  support lands; tasks already work without a tracker (blank
                  tasks on a branch).
                </p>
              )}
            </div>
          )}
        </div>
        {found && hasProposal && (
          <fieldset className="card add-repo-choice">
            <label className="checkbox">
              <input
                type="radio"
                name="add-repo-write"
                checked={write}
                onChange={() => setWrite(true)}
              />
              <span>
                <strong>Write .shellie.yml to the repository</strong>{' '}
                <span className="muted">
                  &mdash; teammates get the same setup
                </span>
              </span>
            </label>
            <label className="checkbox">
              <input
                type="radio"
                name="add-repo-write"
                checked={!write}
                onChange={() => {
                  setWrite(false);
                  setEditing(false);
                }}
              />
              <span>
                <strong>Keep these defaults in Shellie only</strong>{' '}
                <span className="muted">
                  &mdash; nothing is written to the repo
                </span>
              </span>
            </label>
            {!write && (
              <p className="small muted">
                Shellie then uses its built-in defaults (npm ci when there is a
                package-lock.json); the proposal above is not kept.
              </p>
            )}
          </fieldset>
        )}
        <div className="add-repo-actions">
          <button type="button" className="btn" onClick={goBack}>
            Back
          </button>
          <span className="grow" />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canAdd}
            onClick={() => void add()}
          >
            Add repository
          </button>
        </div>
      </div>
    </div>
  );
}
