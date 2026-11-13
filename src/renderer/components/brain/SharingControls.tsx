import { useState } from 'react';
import type { BrainView } from '../../../shared/brain';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { orgName } from './sharing';

type Step = null | 'ask' | 'stop' | 'take' | 'leave';

/** The keeper of a shared brain with colleagues who joined: archiving, deleting or stopping first asks to hand over. */
export const asksHandOver = (brain: BrainView): boolean =>
  !!brain.sharing && !!brain.keeper?.me && brain.keeper.members.length > 0;

/** A member (not the keeper) of a shared brain: they leave it rather than archive or delete it. */
export const isMember = (brain: BrainView): boolean =>
  !!brain.sharing && !!brain.keeper && !brain.keeper.me;

/**
 * Asks the keeper to hand over before they stop, archive or delete, so the brain-wide automatic jobs keep running for
 * the colleagues: a member to pick and Hand over, or `<anyway>` to go on without.
 */
export function HandOverFirst({
  brain,
  anyway,
  onAnyway,
  onCancel,
}: {
  brain: BrainView;
  /** The label of going on without a hand-over ("Stop anyway"). */
  anyway: string;
  onAnyway: () => void;
  onCancel: () => void;
}) {
  const [member, setMember] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `handover-${brain.id}`;
  const members = brain.keeper?.members ?? [];
  const handOver = async () => {
    setBusy(true);
    setError(null);
    try {
      await api().invoke('brain:handOver', brain.id, member);
      onCancel();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="conn-confirm" role="status">
      <span>
        You keep this brain. Hand over first, so the digest, /sync and the other
        automatic jobs keep running for your colleagues.
      </span>
      <label htmlFor={id}>New keeper</label>
      <select
        id={id}
        className="field"
        value={member}
        onChange={(e) => setMember(e.target.value)}
      >
        <option value="">Pick a member</option>
        {members.map((m) => (
          <option key={m.installId} value={m.installId}>
            {m.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy || !member}
        onClick={() => void handOver()}
      >
        Hand over
      </button>
      <button
        type="button"
        className="btn btn-warn btn-sm"
        disabled={busy}
        onClick={onAnyway}
      >
        {anyway}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
        Cancel
      </button>
      {error && (
        <div className="conn-status-bad" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * A shared brain's keeper and the ways out: hand over and Stop sharing (the keeper), take over and Leave (a member).
 */
export function SharingControls({ brain }: { brain: BrainView }) {
  const [step, setStep] = useState<Step>(null);
  const [member, setMember] = useState('');
  const [withFolder, setWithFolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keeper = brain.keeper;
  const sharing = brain.sharing;
  if (!sharing || !keeper) return null;

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      setStep(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const id = `keeper-${brain.id}`;
  return (
    <div className="small">
      <div>
        Shared on {orgName(sharing.homeOrganizationUrl)}/{sharing.homeProject}.
        Keeper: {keeper.me ? 'you' : keeper.name}.
      </div>
      <div className="row">
        {keeper.me && keeper.members.length > 0 && (
          <>
            <label htmlFor={id}>Hand over to</label>
            <select
              id={id}
              className="field"
              value={member}
              onChange={(e) => setMember(e.target.value)}
            >
              <option value="">Pick a member</option>
              {keeper.members.map((m) => (
                <option key={m.installId} value={m.installId}>
                  {m.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy || !member}
              onClick={() =>
                void run(() => api().invoke('brain:handOver', brain.id, member))
              }
            >
              Hand over
            </button>
          </>
        )}
        {!keeper.me && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setStep('take')}
          >
            Take over
          </button>
        )}
        {keeper.me ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setStep(asksHandOver(brain) ? 'ask' : 'stop')}
          >
            Stop sharing
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setStep('leave')}
          >
            Leave
          </button>
        )}
      </div>
      {step === 'ask' && (
        <HandOverFirst
          brain={brain}
          anyway="Stop anyway"
          onAnyway={() => setStep('stop')}
          onCancel={() => setStep(null)}
        />
      )}
      {step === 'stop' && (
        <div className="conn-confirm" role="status">
          <span>
            This brain becomes local again. Its folder and history stay; what
            colleagues already have stays with them. The repo stays; delete it
            in Azure DevOps to end it for everyone.
          </span>
          <button
            type="button"
            className="btn btn-warn btn-sm"
            disabled={busy}
            onClick={() =>
              void run(() => api().invoke('brain:stopSharing', brain.id))
            }
          >
            Stop sharing this brain
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setStep(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {step === 'leave' && (
        <div className="conn-confirm" role="status">
          <span>
            Leave this brain? Colleagues keep it. Your copy stops syncing and is
            archived, or deleted.
          </span>
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
              void run(() => api().invoke('brain:leave', brain.id, 'archive'))
            }
          >
            Leave and archive
          </button>
          <button
            type="button"
            className="btn btn-warn btn-sm"
            disabled={busy}
            onClick={() =>
              void run(() =>
                api().invoke('brain:leave', brain.id, 'delete', withFolder),
              )
            }
          >
            Leave and delete
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setStep(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {step === 'take' && (
        <div className="conn-confirm" role="status">
          <span>
            Take over from {keeper.name}? Allowed when their Shellie has not
            sent changes in 14 days. The weekly digest, /sync and the other
            automatic jobs then run here.
          </span>
          <button
            type="button"
            className="btn btn-warn btn-sm"
            disabled={busy}
            onClick={() =>
              void run(() => api().invoke('brain:takeOver', brain.id))
            }
          >
            Take over as keeper
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setStep(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {error && (
        <div className="conn-status-bad" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
