import type { Connection, ConnectionPatch, Repo } from '../../shared/types';
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
): string[] {
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
    .map((r) => r.id);
}

type ApplyDeps = {
  settings: { get(): AppSettings; save(s: AppSettings): Promise<unknown> };
  connections: {
    list(): Connection[];
    patch(id: string, patch: ConnectionPatch): Promise<unknown>;
  };
  store: {
    state: { repos: Repo[] };
    update(mutate: (s: { repos: Repo[] }) => void): Promise<unknown>;
  };
  log: (message: string, err: unknown) => void;
};

/**
 * Applies both migrations at boot, never fatal. Every connection patch runs on its own; the legacy key is removed
 * from the settings only when all of them succeeded (a failed one retries at the next boot). The start-settings
 * step runs whatever the write-time step did.
 */
export async function applyProjectScopeMigration(
  deps: ApplyDeps,
): Promise<void> {
  const { settings, connections, store, log } = deps;
  try {
    const wt = migrateWriteTime(settings.get(), connections.list());
    if (wt) {
      let failed = false;
      for (const p of wt.patches) {
        try {
          await connections.patch(p.id, { writeTimeToAdo: p.writeTimeToAdo });
        } catch (err) {
          failed = true;
          log(`Project scope migration: patching ${p.id} failed`, err);
        }
      }
      if (!failed) await settings.save(wt.settings);
    }
  } catch (err) {
    log('Project scope migration (write time) failed', err);
  }
  try {
    const drop = new Set(
      migrateStartSettings(store.state.repos, connections.list()),
    );
    if (drop.size > 0)
      await store.update((s) => {
        for (const r of s.repos) if (drop.has(r.id)) delete r.workItemOnStart;
      });
  } catch (err) {
    log('Project scope migration (start settings) failed', err);
  }
}
