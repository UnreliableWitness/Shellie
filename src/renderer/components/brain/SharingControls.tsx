import { useState } from 'react';
import type { BrainView } from '../../../shared/brain';
import { errorMessage } from '../../../shared/errors';
import { api } from '../../api';
import { orgName } from './sharing';

type Step = null | 'stop' | 'take';

/** A shared brain's keeper: who it is, hand over (the keeper), take over (a member), and Stop sharing. */
export function SharingControls({ brain }: { brain: BrainView }) {
  const [step, setStep] = useState<Step>(null);
  const [member, setMember] = useState('');
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
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setStep('stop')}
        >
          Stop sharing
        </button>
      </div>
      {step === 'stop' && (
        <div className="conn-confirm" role="status">
          <span>
            This brain becomes local again. Its folder and history stay; what
            colleagues already have stays with them.
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
