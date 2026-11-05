import { StartSettingsSchema } from './types';
import type { Connection, Repo, StartSettings } from './types';

/** Where a repo's start settings come from: its own value, else its project's (connection), else the app default. */
export function startSettingsSource(
  repo: Pick<Repo, 'workItemOnStart'>,
  connection: Pick<Connection, 'workItemOnStart'> | null,
): 'repo' | 'project' | 'default' {
  if (repo.workItemOnStart) return 'repo';
  return connection ? 'project' : 'default';
}

export function effectiveStartSettings(
  repo: Pick<Repo, 'workItemOnStart'>,
  connection: Pick<Connection, 'workItemOnStart'> | null,
): StartSettings {
  return (
    repo.workItemOnStart ??
    connection?.workItemOnStart ??
    StartSettingsSchema.parse({})
  );
}
