import { useEffect, useState } from 'react';
import type { JoinPreview } from '../../shared/brainShare';
import { errorMessage } from '../../shared/errors';
import { api } from '../api';
import { PageHeader } from '../components/ui';
import { useStore } from '../store';

/**
 * What a `shellie://join` link leads to: a token field first when nothing reaches the link's organization (main is
 * then asked again with it), then the brain and project, and Join.
 * `via`: whether a link or the "Your team has a brain" card opened it (telemetry only).
 */
export function BrainJoinScreen({
  link,
  via = 'link',
}: {
  link: string;
  via?: 'link' | 'card';
}) {
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

  /** With a token typed: asks main again with it, which reads the brain's name and project from the repo. */
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api().invoke('brain:previewJoin', link, pat.trim()));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = pat.trim() || undefined;
      const brain = await api().invoke('brain:join', link, token, via);
      go({ kind: 'brain', brainId: brain.id });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const known = preview && !preview.needsToken ? preview : null;
  const can = known && known.connectionId !== null && !known.alreadyHave;
  return (
    <div className="page">
      <PageHeader title="Join a brain" />
      <div className="page-body brain-join">
        {!preview && !error && <p className="muted">Loading</p>}
        {preview?.needsToken && (
          <form
            className="conn-form"
            onSubmit={(e) => {
              e.preventDefault();
              void check();
            }}
          >
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
              A token for {preview.organizationUrl}, with Code read and write.
              Shellie keeps it encrypted.
            </span>
            <span />
            <div className="actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !pat.trim()}
              >
                Continue
              </button>
            </div>
          </form>
        )}
        {known && (
          <h2>
            {known.name}, the brain for {known.project}
          </h2>
        )}
        {known?.alreadyHave && (
          <p>You already have a brain for this project.</p>
        )}
        {known && known.connectionId === null && (
          <>
            <p>Add the {known.project} project in Shellie first.</p>
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
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void join()}
            >
              Join
            </button>
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
