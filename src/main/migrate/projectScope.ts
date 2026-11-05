import type { Connection, Repo } from '../../shared/types';
import type { AppSettings } from '../../shared/usage';
import { isDeepStrictEqual } from 'node:util';

/**
 * Moves the old global "write booked time to Azure DevOps" flag onto every connection (project). Returns null when
 * the legacy key is absent (already migrated, or a fresh install); otherwise the settings without the key and one
 * patch per connection.
 */
export function migrateWriteTime(
  settings: AppSettings,
  connections: Connection[],
): {
  settings: AppSettings;
  patches: { id: string; writeTimeToAdo: boolean }[];
} | null {
  if (settings.writeTimeToAdo === undefined) return null;
  const { writeTimeToAdo, ...rest } = settings;
  return {
    settings: rest,
    patches: connections.map((c) => ({ id: c.id, writeTimeToAdo })),
  };
}

/** Repos whose own on-start options are only a copy of their project's default: the value can go and the repo inherits. */
export function migrateStartSettings(
  repos: Repo[],
  connections: Connection[],
): { id: string }[] {
  const byId = new Map(connections.map((c) => [c.id, c]));
  return repos
    .filter((r) => {
      const c = r.connectionId ? byId.get(r.connectionId) : undefined;
      return (
        c !== undefined &&
        r.workItemOnStart !== undefined &&
        isDeepStrictEqual(r.workItemOnStart, c.workItemOnStart)
      );
    })
    .map((r) => ({ id: r.id }));
}
