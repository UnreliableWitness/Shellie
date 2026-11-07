import { useEffect, useRef, useState } from 'react';
import type { Channels } from '../../shared/ipc';
import { api, saveSettings, tryInvoke } from '../api';
import { errorMessage } from '../../shared/errors';
import {
  ProviderPicker,
  type ProviderChoice,
} from '../components/ProviderPicker';
import { PageHeader, StepStrip } from '../components/ui';
import { useActiveBrains } from '../hooks/useBrains';
import { nextStep, stepsFrom } from '../onboardingState';
import { useStore } from '../store';
import { track } from '../telemetry';

type Probe = Channels['connections:probe']['result'];

const SCOPES = [
  'Work Items (Read & write)',
  'Code (Read & write)',
  'Project and Team (Read)',
  'Wiki (Read)',
];

/** The organization URL Shellie stores (`https://dev.azure.com/<org>` or the visualstudio.com origin) from whatever was typed; null until it reads as one. */
function organizationOf(input: string): string | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.hostname.toLowerCase() === 'dev.azure.com') {
      const org = url.pathname.split('/').filter(Boolean)[0];
      return org ? `https://dev.azure.com/${org}` : null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** The organization's personal access tokens page; null until the URL reads as an organization. */
function tokensPageUrl(input: string): string | null {
  const org = organizationOf(input);
  return org ? `${org}/_usersSettings/tokens` : null;
}

/** First-run step 2 and Settings' way to add a connection: pick a tracker, test a token, pick projects. */
export function ConnectScreen() {
  const screen = useStore((s) => s.screen);
  const go = useStore((s) => s.go);
  const back = useStore((s) => s.back);
  const notify = useStore((s) => s.notify);
  const setConnections = useStore((s) => s.setConnections);
  const connections = useStore((s) => s.connections);
  const from = screen.kind === 'connect' ? screen.from : 'settings';
  const connectionId =
    screen.kind === 'connect' ? screen.connectionId : undefined;
  const brains = useActiveBrains();
  const onboarding = from === 'get-started';
  const existing = connectionId
    ? connections.find((c) => c.id === connectionId)
    : undefined;

  const [choice, setChoice] = useState<ProviderChoice>('azure-devops');
  const [organizationUrl, setOrganizationUrl] = useState(
    existing?.organizationUrl ?? '',
  );
  const [pat, setPat] = useState('');
  const [probe, setProbe] = useState<Probe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [move, setMove] = useState(true);
  const [assign, setAssign] = useState(true);
  const [busy, setBusy] = useState(false);

  /** Projects this organization already has a connection for, also when its URL is typed again. */
  const organization = (
    existing?.organizationUrl ?? organizationOf(organizationUrl)
  )?.toLowerCase();
  const added = new Set(
    connections
      .filter((c) => c.organizationUrl.toLowerCase() === organization)
      .map((c) => c.project.toLowerCase()),
  );

  const redact = (message: string) =>
    pat ? message.split(pat).join('***') : message;

  const latest = useRef(0);
  const test = async () => {
    const id = ++latest.current;
    setTesting(true);
    setError(null);
    setProbe(null);
    try {
      const result = await api().invoke(
        'connections:probe',
        connectionId
          ? { organizationUrl, connectionId }
          : { organizationUrl, pat },
      );
      if (id !== latest.current) return;
      setProbe(result);
      const fresh = result.projects.filter(
        (p) => !added.has(p.name.toLowerCase()),
      );
      setTicked(result.projects.length === 1 ? fresh.map((p) => p.name) : []);
    } catch (e) {
      if (id === latest.current) setError(redact(errorMessage(e)));
    } finally {
      if (id === latest.current) setTesting(false);
    }
  };

  useEffect(() => {
    // Adding a project to a known organization needs no token: test it straight away.
    if (connectionId) void test();
    // Once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stale = () => {
    latest.current++;
    setProbe(null);
    setError(null);
    setTesting(false);
  };

  const projects = probe?.canListProjects
    ? ticked
    : typed.trim()
      ? [typed.trim()]
      : [];
  const canContinue =
    !busy && (choice === 'none' || (!!probe && projects.length > 0));

  const leave = () =>
    onboarding
      ? go(nextStep(stepsFrom({ ...useStore.getState(), brains }), 'connect'))
      : go({ kind: 'settings', section: 'ado' });

  const goBack = () => {
    if (onboarding)
      track('onboarding.step', { step: 'connect', outcome: 'back' });
    if (onboarding) back();
    else leave();
  };

  const skip = () => {
    track('onboarding.step', { step: 'connect', outcome: 'skipped' });
    leave();
  };

  const finish = () => {
    if (onboarding)
      track('onboarding.step', { step: 'connect', outcome: 'continued' });
    leave();
  };

  const proceed = async () => {
    setBusy(true);
    try {
      if (choice === 'none') {
        const saved = await tryInvoke(
          () =>
            saveSettings((f) => ({
              onboarding: { ...f.onboarding, tracker: 'none' },
            })),
          notify,
        );
        if (saved) finish();
        return;
      }
      setError(null);
      let saved;
      try {
        saved = await api().invoke('connections:saveMany', {
          organizationUrl,
          ...(connectionId ? { connectionId } : { pat }),
          projects,
          workItemOnStart: {
            moveToInProgress: move,
            assignToMe: assign,
            stateOverrides: {},
          },
          provider: 'azure-devops',
        });
      } catch (e) {
        setError(redact(errorMessage(e)));
        return;
      }
      if (saved.length === 0) {
        notify('info', 'Every ticked project is already connected');
        return;
      }
      const list = await tryInvoke(
        () => api().invoke('connections:list'),
        notify,
      );
      if (list) setConnections(list);
      setPat('');
      finish();
    } finally {
      setBusy(false);
    }
  };

  const tokensUrl = tokensPageUrl(organizationUrl);
  const openTokens = (e: React.MouseEvent) => {
    e.preventDefault();
    if (tokensUrl)
      void tryInvoke(
        () => api().invoke('shell:openExternal', tokensUrl),
        notify,
      );
  };
  const copyScopes = () =>
    void navigator.clipboard
      .writeText(SCOPES.join(', '))
      .catch(() => notify('error', 'Could not copy to the clipboard.'));

  const toggle = (name: string) =>
    setTicked((t) =>
      t.includes(name) ? t.filter((x) => x !== name) : [...t, name],
    );

  const testButton = (
    <button
      type="button"
      className="btn btn-primary"
      onClick={test}
      disabled={
        testing || !organizationUrl.trim() || (!connectionId && !pat.trim())
      }
    >
      Test
    </button>
  );

  return (
    <div className="page">
      {onboarding && <StepStrip current="connect" />}
      <PageHeader
        title={existing ? 'Add a project' : 'Where do your work items live?'}
      />
      <div className="page-body connect">
        <p className="muted">
          {existing
            ? `Projects of ${existing.organizationUrl}, with the token you already saved.`
            : 'Each project you tick becomes a project in Shellie with its own page and settings; add more later in Settings › Projects.'}
        </p>
        {!existing && <ProviderPicker value={choice} onChange={setChoice} />}
        {choice === 'none' && (
          <p className="card connect-none">
            Tasks start blank on a branch: no work item, nothing written back.
            You can connect a tracker later in Settings.
          </p>
        )}
        {choice === 'azure-devops' && (
          <div className="card connect-form">
            <label htmlFor="connect-url" className="muted">
              Organization URL
            </label>
            <div className="connect-field">
              <input
                id="connect-url"
                className="field mono"
                value={organizationUrl}
                readOnly={!!existing}
                placeholder="https://dev.azure.com/your-org"
                onChange={(e) => {
                  setOrganizationUrl(e.target.value);
                  stale();
                }}
              />
              {existing && testButton}
            </div>
            {!existing && (
              <>
                <label htmlFor="connect-pat" className="muted">
                  Personal access token
                </label>
                <div>
                  <div className="connect-field">
                    <input
                      id="connect-pat"
                      className="field mono"
                      type="password"
                      autoComplete="off"
                      value={pat}
                      onChange={(e) => {
                        setPat(e.target.value);
                        stale();
                      }}
                    />
                    {testButton}
                  </div>
                  <p className="small muted" data-testid="connect-scopes">
                    Needs the scopes{' '}
                    {SCOPES.map((s, i) => (
                      <span key={s}>
                        <strong>{s}</strong>
                        {i < SCOPES.length - 1 ? ', ' : '. '}
                      </span>
                    ))}
                    <button type="button" className="link" onClick={copyScopes}>
                      Copy
                    </button>
                    {tokensUrl && (
                      <>
                        {' '}
                        &middot;{' '}
                        <a
                          href={tokensUrl}
                          className="link"
                          onClick={openTokens}
                        >
                          Open the tokens page &#8599;
                        </a>
                      </>
                    )}
                  </p>
                  <p className="small muted">
                    Wiki (Read) is only needed for a brain.
                  </p>
                </div>
              </>
            )}
            {error && (
              <p className="connect-error" role="alert">
                {error}
              </p>
            )}
            {probe && (
              <>
                <div className="connect-signed">
                  <span className="pill-ok">Signed in as {probe.user}</span>
                  {probe.canListProjects && (
                    <span className="small muted">
                      {probe.projects.length === 1
                        ? '1 project'
                        : `${probe.projects.length} projects`}
                    </span>
                  )}
                </div>
                <span className="muted">Projects to show</span>
                {probe.canListProjects ? (
                  <div className="connect-checks">
                    {probe.projects.map((p) => {
                      const known = added.has(p.name.toLowerCase());
                      return (
                        <label key={p.id} className="checkbox">
                          <input
                            type="checkbox"
                            checked={known || ticked.includes(p.name)}
                            disabled={known}
                            onChange={() => toggle(p.name)}
                          />
                          <span>
                            {p.name}
                            {known && <span className="muted"> (added)</span>}
                          </span>
                        </label>
                      );
                    })}
                    {probe.projects.length === 0 && (
                      <span className="small muted">
                        The token sees no projects in this organization.
                      </span>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="connect-warn small">
                      The token can sign in but cannot list projects: add
                      Project and Team (Read)
                    </p>
                    <input
                      className="field"
                      aria-label="Project name"
                      placeholder="Or type the project name"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                    />
                  </div>
                )}
                <span className="muted">On task start</span>
                <div className="connect-checks">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={move}
                      onChange={(e) => setMove(e.target.checked)}
                    />
                    <span>Move the work item to In Progress</span>
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={assign}
                      onChange={(e) => setAssign(e.target.checked)}
                    />
                    <span>Assign it to me</span>
                  </label>
                </div>
              </>
            )}
          </div>
        )}
        <div className="add-repo-actions">
          <button type="button" className="btn" onClick={goBack}>
            Back
          </button>
          {onboarding && (
            <button type="button" className="link" onClick={skip}>
              Skip for now
            </button>
          )}
          <span className="grow" />
          {choice === 'azure-devops' && (
            <span className="small muted">
              Writing time back to work items stays off until you turn it on per
              project.
            </span>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canContinue}
            onClick={proceed}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
