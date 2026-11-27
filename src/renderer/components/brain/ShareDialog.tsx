import { useEffect, useRef, useState } from 'react';
import type { BrainView } from '../../../shared/brain';
import type { BrainHome, ShareStep } from '../../../shared/brainShare';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { useStore } from '../../store';
import { CopyField } from './CopyField';
import { orgName } from './sharing';

type Where = 'company' | 'customer' | 'repo';
type Result =
  | { status: 'idle' }
  /** `again`: this is the one re-call after the sync; a second `syncing` stops there. */
  | { status: 'syncing'; since: number; again: boolean }
  | { status: 'secrets'; files: string[] }
  /** Nothing on this machine opens the repo: a token for `host` is asked for. */
  | { status: 'needsToken'; host: string; tried: string[] }
  | { status: 'shared'; joinLink: string };

/** What the share is doing now, as the card says it while it waits. */
export function stepText(step: ShareStep | null, percent: number | null) {
  switch (step) {
    case 'opening':
      return 'Opening the repo';
    case 'checking':
      return 'Checking the brain for changes and secrets';
    case 'creating':
      return 'Creating the repo';
    case 'uploading':
      return percent === null
        ? 'Uploading the brain'
        : percent >= 100
          ? 'Uploading the brain: finishing'
          : `Uploading the brain: ${percent}%`;
    default:
      return 'Starting';
  }
}

/** The line a share in progress shows: its step, a moving bar, and how long it has taken. */
function ShareProgress({ brainId }: { brainId: string }) {
  const [at, setAt] = useState<{
    step: ShareStep | null;
    percent: number | null;
  }>({ step: null, percent: null });
  const [seconds, setSeconds] = useState(0);
  useEffect(
    () =>
      api().on('brain:shareProgress', (e) => {
        if (e.brainId === brainId) setAt({ step: e.step, percent: e.percent });
      }),
    [brainId],
  );
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.round((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  const known = at.step === 'uploading' && at.percent !== null;
  return (
    <div className="brain-share-progress">
      <div role="status" className="small">
        {stepText(at.step, at.percent)}…
        {seconds >= 5 && <span className="muted"> {seconds} s</span>}
      </div>
      <div
        className={`brain-share-bar${known ? '' : ' is-busy'}`}
        role="progressbar"
        aria-label="Sharing"
        {...(known
          ? {
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': at.percent ?? 0,
            }
          : {})}
      >
        <span style={known ? { width: `${at.percent}%` } : undefined} />
      </div>
      {at.step === 'uploading' && (
        <p className="small muted">
          A large brain can take a few minutes. Keep Shellie open.
        </p>
      )}
    </div>
  );
}

/** Share a local brain: where it lives, its name there, what goes along. A card in the page, not an overlay. */
export function ShareDialog({
  brain,
  onClose,
  onSources,
}: {
  /** The live brain: its sync job ending is what `syncing` waits for. */
  brain: BrainView;
  onClose: () => void;
  /** Takes the person to the Sources list. */
  onSources: () => void;
}) {
  const connection = useStore((s) =>
    s.connections.find((c) => c.id === brain.connectionId),
  );
  const [home, setHome] = useState<BrainHome | null | undefined>(undefined);
  const [picked, setPicked] = useState<Where | null>(null);
  const [repoName, setRepoName] = useState(brain.name);
  const [repoUrl, setRepoUrl] = useState('');
  const [repoToken, setRepoToken] = useState('');
  const [result, setResult] = useState<Result>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api()
      .invoke('brainHome:get')
      .then(
        (h) => live && setHome(h),
        () => live && setHome(null),
      );
    return () => {
      live = false;
    };
  }, []);

  const where: Where = picked ?? (home ? 'company' : 'customer');
  const customerOrg = connection ? orgName(connection.organizationUrl) : '';
  const org =
    where === 'company' && home ? orgName(home.organizationUrl) : customerOrg;

  const share = async (again = false) => {
    setBusy(true);
    setError(null);
    try {
      const started = Date.now();
      const r = await api().invoke('brain:share', {
        brainId: brain.id,
        home: where,
        repoName: repoName.trim(),
        ...(where === 'repo'
          ? {
              repoUrl: repoUrl.trim(),
              ...(repoToken.trim() ? { repoToken: repoToken.trim() } : {}),
            }
          : {}),
      });
      if (r.status === 'syncing' && again) {
        // Never a second paid /sync on its own: the person decides.
        setResult({ status: 'idle' });
        setError('The brain changed while it synced. Share again.');
        return;
      }
      setResult(
        r.status === 'syncing'
          ? { status: 'syncing', since: started, again }
          : r.status === 'secrets'
            ? { status: 'secrets', files: r.files }
            : r.status === 'needsToken'
              ? { status: 'needsToken', host: r.host, tried: r.tried }
              : { status: 'shared', joinLink: r.joinLink },
      );
    } catch (e) {
      setResult({ status: 'idle' });
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // A /sync was queued first: when it is done, ask once more; when it failed, say so and stop.
  const shareAgain = useRef(share);
  shareAgain.current = share;
  const waitingSince = result.status === 'syncing' ? result.since : null;
  const syncEnd =
    waitingSince === null
      ? null
      : (brain.jobs.find(
          (j) =>
            j.kind === 'sync' &&
            (j.status === 'done' || j.status === 'failed') &&
            j.endedAt !== null &&
            Date.parse(j.endedAt) >= waitingSince,
        )?.status ?? null);
  useEffect(() => {
    if (syncEnd === 'done') void shareAgain.current(true);
    else if (syncEnd === 'failed') {
      setResult({ status: 'idle' });
      setError(
        'The sync before sharing failed. Look at the job, then share again.',
      );
    }
  }, [syncEnd]);

  const shared = result.status === 'shared' ? result : null;
  return (
    <section
      role="dialog"
      aria-label="Share with colleagues"
      className="brain-card brain-share"
    >
      <h2>Share with colleagues</h2>
      {shared ? (
        <>
          <p className="small">Shared. Colleagues join with this link:</p>
          <CopyField label="Join link" value={shared.joinLink} />
          {where === 'repo' && (
            <p className="small muted">
              They need access to the repo, and the project added in Shellie. If
              the link does not open Shellie, they paste it under Settings, the
              project, Brains, "Join a shared brain".
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
            >
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <fieldset className="brain-share-where" disabled={busy}>
            <legend className="small muted">Where it lives</legend>
            {home && (
              <label className="row">
                <input
                  type="radio"
                  name="share-where"
                  checked={where === 'company'}
                  onChange={() => setPicked('company')}
                />
                Company brain home ({orgName(home.organizationUrl)})
              </label>
            )}
            <label className="row">
              <input
                type="radio"
                name="share-where"
                checked={where === 'customer'}
                onChange={() => setPicked('customer')}
              />
              This customer project ({customerOrg}/{connection?.project})
            </label>
            <label className="row">
              <input
                type="radio"
                name="share-where"
                checked={where === 'repo'}
                onChange={() => setPicked('repo')}
              />
              A repo I made (GitHub or another git host)
            </label>
          </fieldset>
          {where === 'repo' ? (
            <>
              <label htmlFor="share-repo-url">Repo address</label>
              <input
                id="share-repo-url"
                className="field mono"
                placeholder="https://github.com/acme/project-brain"
                value={repoUrl}
                disabled={busy}
                onChange={(e) => setRepoUrl(e.target.value)}
              />
              <p className="small muted">
                An empty private repo (made without a README). Shellie signs in
                as git does on this machine, or as the GitHub CLI account that
                can open the repo.
              </p>
              {result.status === 'needsToken' && (
                <>
                  <label htmlFor="share-repo-token">Token</label>
                  <input
                    id="share-repo-token"
                    className="field mono"
                    type="password"
                    autoComplete="off"
                    value={repoToken}
                    disabled={busy}
                    onChange={(e) => setRepoToken(e.target.value)}
                  />
                  <p className="small" role="alert">
                    Nothing on this machine can open that repo on {result.host}.
                    {result.tried.length > 0 &&
                      ` Tried: ${result.tried.join('; ')}.`}{' '}
                    Check the address, or enter a token that can read and write
                    it (for GitHub: a fine-grained personal access token with
                    Contents: read and write). Shellie keeps it encrypted.
                  </p>
                </>
              )}
            </>
          ) : (
            <>
              <label htmlFor="share-repo">Name</label>
              <input
                id="share-repo"
                className="field"
                value={repoName}
                disabled={busy}
                onChange={(e) => setRepoName(e.target.value)}
              />
              <p className="small muted">
                Everyone with access to {org} sees this name.
              </p>
            </>
          )}
          <p className="small muted">
            Everything in Sources goes along. To keep one out, remove it first.{' '}
            <button type="button" className="link" onClick={onSources}>
              Sources
            </button>
          </p>
          {busy && <ShareProgress brainId={brain.id} />}
          {result.status === 'syncing' && (
            <div className="brain-share-progress">
              <div role="status" className="small">
                Syncing first. Shellie shares when that is done…
              </div>
              <div className="brain-share-bar is-busy">
                <span />
              </div>
            </div>
          )}
          {result.status === 'secrets' && (
            <div className="small" role="alert">
              <p>Possible secrets in these files. Scrub them, then share.</p>
              <ul>
                {result.files.map((f) => (
                  <li key={f} className="mono">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <p role="alert" className="conn-status-bad">
              {error}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={
                busy ||
                result.status === 'syncing' ||
                home === undefined ||
                !(where === 'repo' ? repoUrl.trim() : repoName.trim()) ||
                (result.status === 'needsToken' && !repoToken.trim())
              }
              onClick={() => void share()}
            >
              {busy ? 'Sharing…' : 'Share'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}
