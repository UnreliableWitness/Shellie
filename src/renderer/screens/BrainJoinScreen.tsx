import { useEffect, useState } from 'react';
import type { JoinPreview } from '../../shared/brainShare';
import { errorMessage } from '../../shared/errors';
import { api } from '../api';
import { PageHeader } from '../components/ui';
import { useStore } from '../store';

/** What a `shellie://join` link leads to: the brain and project, a token field when the link needs one, and Join. */
export function BrainJoinScreen({ link }: { link: string }) {
  const go = useStore((s) => s.go);
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPreview(null);
    setError(null);
    api()
      .invoke('brain:previewJoin', link)
      .then(
        (p) => live && setPreview(p),
        (e: unknown) => live && setError(errorMessage(e)),
      );
    return () => {
      live = false;
    };
  }, [link]);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = pat.trim() || undefined;
      const brain = await api().invoke('brain:join', link, token);
      go({ kind: 'brain', brainId: brain.id });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const can = preview && preview.connectionId !== null && !preview.alreadyHave;
  return (
    <div className="page">
      <PageHeader title="Join a brain" />
      <div className="page-body brain-join">
        {!preview && !error && <p className="muted">Loading</p>}
        {preview && (
          <h2>
            {preview.name}, the brain for {preview.project}
          </h2>
        )}
        {preview?.alreadyHave && (
          <p>You already have a brain for this project.</p>
        )}
        {preview && preview.connectionId === null && (
          <>
            <p>Add the {preview.project} project in Shellie first.</p>
            <div className="actions">
              <button
                type="button"
                className="btn"
                onClick={() => go({ kind: 'connect', from: 'settings' })}
              >
                Add project
              </button>
            </div>
          </>
        )}
        {can && (
          <form
            className="conn-form"
            onSubmit={(e) => {
              e.preventDefault();
              void join();
            }}
          >
            {preview.needsToken && (
              <>
                <label htmlFor="join-token">Token</label>
                <input
                  id="join-token"
                  className="field mono"
                  type="password"
                  autoComplete="off"
                  value={pat}
                  onChange={(e) => setPat(e.target.value)}
                />
                <span />
                <span className="small muted">
                  A token for {preview.organizationUrl}, with Code read and
                  write. Shellie keeps it encrypted.
                </span>
              </>
            )}
            <span />
            <div className="actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || (preview.needsToken && !pat.trim())}
              >
                Join
              </button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="conn-status-bad">
            {error}
          </p>
        )}
        <div className="actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => go({ kind: 'home' })}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
