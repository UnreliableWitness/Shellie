import { useEffect, useRef, useState } from 'react';
import type { BrainView } from '../../../shared/brain';
import type { BrainHome } from '../../../shared/brainShare';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { useStore } from '../../store';
import { orgName } from './sharing';

type Where = 'company' | 'customer';
type Result =
  | { status: 'idle' }
  | { status: 'syncing'; since: number }
  | { status: 'secrets'; files: string[] }
  | { status: 'shared'; joinLink: string };

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
  const notify = useStore((s) => s.notify);
  const connection = useStore((s) =>
    s.connections.find((c) => c.id === brain.connectionId),
  );
  const [home, setHome] = useState<BrainHome | null | undefined>(undefined);
  const [picked, setPicked] = useState<Where | null>(null);
  const [repoName, setRepoName] = useState(brain.name);
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

  const share = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = Date.now();
      const r = await api().invoke('brain:share', {
        brainId: brain.id,
        home: where,
        repoName: repoName.trim(),
      });
      setResult(
        r.status === 'syncing'
          ? { status: 'syncing', since: started }
          : r.status === 'secrets'
            ? { status: 'secrets', files: r.files }
            : { status: 'shared', joinLink: r.joinLink },
      );
    } catch (e) {
      setResult({ status: 'idle' });
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // A /sync was queued first: when it ends, ask again.
  const shareAgain = useRef(share);
  shareAgain.current = share;
  const waitingSince = result.status === 'syncing' ? result.since : null;
  const syncEnded =
    waitingSince !== null &&
    brain.jobs.some(
      (j) =>
        j.kind === 'sync' &&
        (j.status === 'done' || j.status === 'failed') &&
        j.endedAt !== null &&
        Date.parse(j.endedAt) >= waitingSince,
    );
  useEffect(() => {
    if (syncEnded) void shareAgain.current();
  }, [syncEnded]);

  const copy = (link: string) =>
    navigator.clipboard
      .writeText(link)
      .then(() => notify('info', 'Join link copied'))
      .catch((e: unknown) => notify('error', errorMessage(e)));

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
          <p className="mono small">{shared.joinLink}</p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void copy(shared.joinLink)}
            >
              Copy join link
            </button>
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
          </fieldset>
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
          <p className="small muted">
            Everything in Sources goes along. To keep one out, remove it first.{' '}
            <button type="button" className="link" onClick={onSources}>
              Sources
            </button>
          </p>
          {result.status === 'syncing' && (
            <p className="small">Syncing first…</p>
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
                !repoName.trim()
              }
              onClick={() => void share()}
            >
              Share
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
