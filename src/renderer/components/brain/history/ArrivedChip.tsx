import type { BrainActivityEntry } from '../../../../shared/brainShare';
import { arrivedText } from './history';

/**
 * Colleagues added to the brain since this person last looked: a spark that lights up in the header and says who
 * and how much. A click opens History. It lights up again each time more arrives.
 */
export function ArrivedChip({
  unseen,
  onOpen,
}: {
  unseen: BrainActivityEntry[];
  onOpen: () => void;
}) {
  if (unseen.length === 0) return null;
  return (
    <button
      // Another arrival plays the light again.
      key={unseen[0].id}
      type="button"
      className="brain-arrived"
      title="See what is new in History"
      onClick={onOpen}
    >
      <span className="brain-arrived-spark" aria-hidden="true" />
      <span role="status">{arrivedText(unseen)}</span>
    </button>
  );
}
