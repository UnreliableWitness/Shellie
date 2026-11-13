import type { BrainView } from '../../../shared/brain';
import { orgName } from './sharing';

/** The sync line of a shared brain (nothing for a local one): what the sync is doing, and a newer-Shellie note. */
export function SharedStatus({ brain }: { brain: BrainView }) {
  const s = brain.sharing;
  if (!s) return null;
  const org = orgName(s.homeOrganizationUrl);
  const text = {
    ok: 'Shared · up to date',
    pending: 'Sending changes',
    unreachable: `Can't reach ${org}`,
    unauthorized: `Can't sign in to ${org}`,
    held: `Held: possible secret in ${s.heldFile ?? 'a file'}`,
  }[s.status];
  const ranAgain = brain.jobs.some(
    (j) => j.kind === 'capture' && j.replays > 0,
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
        <span className="small brain-shared-warn">
          A colleague&apos;s Shellie is newer: update Shellie.
        </span>
      )}
    </>
  );
}
