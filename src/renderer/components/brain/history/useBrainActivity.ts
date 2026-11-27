import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BrainActivityEntry } from '../../../../shared/brainShare';
import { api } from '../../../api';
import { useBrainChanged } from '../../../hooks/useBrains';
import { local } from '../../../localStorage';
import { unseenFromColleagues, withSeen } from './history';

const SEEN = (brainId: string) => `shellie.brain.seen.${brainId}`;

function readSeen(brainId: string): Set<string> | null {
  try {
    const text = local()?.getItem(SEEN(brainId));
    if (!text) return null;
    const ids: unknown = JSON.parse(text);
    return Array.isArray(ids) ? new Set(ids.map(String)) : null;
  } catch {
    return null;
  }
}

function writeSeen(brainId: string, ids: string[]) {
  try {
    local()?.setItem(SEEN(brainId), JSON.stringify(ids));
  } catch {
    // A convenience: without it colleagues' changes are announced again.
  }
}

/**
 * The brain's history, read again whenever the brain changes, and the entries colleagues made that this person has
 * not looked at yet (kept per brain in localStorage). `markSeen` is the look.
 */
export function useBrainActivity(brainId: string): {
  entries: BrainActivityEntry[] | null;
  unseen: BrainActivityEntry[];
  markSeen: () => void;
} {
  const [entries, setEntries] = useState<BrainActivityEntry[] | null>(null);
  const [seen, setSeen] = useState<Set<string> | null>(() => readSeen(brainId));
  const load = useCallback(() => {
    api()
      .invoke('brain:activity', brainId)
      .then(
        (list) => {
          setEntries(list);
          // The first look at this brain: everything it holds counts as seen.
          setSeen((s) => {
            if (s) return s;
            const ids = withSeen(list, null);
            writeSeen(brainId, ids);
            return new Set(ids);
          });
        },
        () => setEntries((e) => e ?? []),
      );
  }, [brainId]);
  useEffect(load, [load]);
  useBrainChanged(brainId, load);
  const unseen = useMemo(
    () => unseenFromColleagues(entries ?? [], seen),
    [entries, seen],
  );
  const markSeen = useCallback(() => {
    if (!entries) return;
    setSeen((s) => {
      const ids = withSeen(entries, s);
      writeSeen(brainId, ids);
      return new Set(ids);
    });
  }, [brainId, entries]);
  return { entries, unseen, markSeen };
}
