import type { BrainView } from '../../../shared/brain';
import { NEWER_SHELLIE } from '../../../shared/brainShare';
import { plural } from '../../../shared/text';
import { orgName } from './sharing';

const RAN_AGAIN_MS = 60 * 60 * 1000;

/** The sync line of a shared brain (nothing for a local one): what the sync is doing, and a newer-Shellie note. */
export function SharedStatus({ brain }: { brain: BrainView }) {
  const s = brain.sharing;
  if (!s) return null;
  const org = orgName(s.homeOrganizationUrl);
  const ahead = s.ahead ?? 0;
  const text = {
    ok: 'Shared · up to date',
    pending: `Sending ${plural(ahead, 'change')}`,
    unreachable: `Can't reach ${org} · ${plural(ahead, 'change')} waiting`,
    unauthorized: `Can't sign in to ${org}`,
    held:
      s.heldReason === 'unchecked'
        ? "Held: the changes couldn't be checked for secrets"
        : `Held: possible secret in ${s.heldFile ?? 'a file'}`,
  }[s.status];
  // Only while it is on, or for an hour after it ended.
  const ranAgain = brain.jobs.some(
    (j) =>
      j.kind === 'capture' &&
      j.replays > 0 &&
      (j.status === 'queued' ||
        j.status === 'running' ||
        (j.endedAt !== null &&
          Date.now() - Date.parse(j.endedAt) < RAN_AGAIN_MS)),
  );
  return (
    <>
      <span
        role="status"
        className={`small ${s.status === 'ok' ? 'muted' : 'brain-shared-warn'}`}
      >
        {text}
        {ranAgain && ' · Ran a capture again'}
      </span>
      {brain.newerShellie && (
        <span className="small brain-shared-warn">{NEWER_SHELLIE}</span>
      )}
    </>
  );
}
