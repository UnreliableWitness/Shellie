import { useCallback, useEffect, useState } from 'react';
import type { Sprint } from '../../shared/types';
import { api } from '../api';
import { errorMessage } from '../../shared/errors';
import { useStore } from '../store';

/** A cached sprint younger than this is served without a fetch. */
const FRESH_MS = 60_000;

/** The current sprint of a connection: the cache at once, refetched when missing or older than a minute. */
export function useSprint(connectionId: string | null): {
  sprint: Sprint | null;
  loading: boolean;
  error: string | null;
  refresh(): void;
} {
  const cached = useStore((s) =>
    connectionId ? (s.sprints[connectionId] ?? null) : null,
  );
  const setSprint = useStore((s) => s.setSprint);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!connectionId) return;
    setLoading(true);
    setError(null);
    api()
      .invoke('workItems:sprint', connectionId)
      .then((sprint) => setSprint(connectionId, sprint))
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [connectionId, setSprint]);

  useEffect(() => {
    if (!connectionId) return;
    const at = useStore.getState().sprints[connectionId]?.at;
    if (at === undefined || Date.now() - at > FRESH_MS) refresh();
  }, [connectionId, refresh]);

  return { sprint: cached?.sprint ?? null, loading, error, refresh };
}
