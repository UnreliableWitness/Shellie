import { useCallback, useEffect, useState } from 'react';
import type { BrainConflicts } from '../../../../shared/brain';
import { api } from '../../../api';
import { useBrainChanged } from '../../../hooks/useBrains';

export const NO_CONFLICTS: BrainConflicts = {
  open: [],
  parked: [],
  settled: [],
  answers: [],
};

/** The brain's conflicts (open, parked, settled), loaded again whenever the brain changes. */
export function useBrainConflicts(brainId: string) {
  const [conflicts, setConflicts] = useState<BrainConflicts>(NO_CONFLICTS);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => {
    api()
      .invoke('brain:conflicts', brainId)
      .then(
        (c) => {
          setConflicts(c);
          setLoaded(true);
        },
        () => setLoaded(true),
      );
  }, [brainId]);
  useEffect(load, [load]);
  useBrainChanged(brainId, load);
  return { conflicts, loaded };
}
