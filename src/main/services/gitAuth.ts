/**
 * Signs git in to Azure Repos with the connection's PAT, so fetch and push do not depend on a credential helper
 * that may not start from Shellie's console-less git. The token goes in an `http.<url>.extraHeader` given through
 * `GIT_CONFIG_*` environment variables, never on the command line, so it is not in GitError messages or logs.
 */

import type { Brain } from '../../shared/brain';
import { BRAIN_HOME_CONNECTION_ID } from '../../shared/brainShare';
import type { Connection, Repo, Task } from '../../shared/types';
import { taskWorkspaces } from '../../shared/workspaces';
import { samePath } from '../paths';
import {
  matchConnection,
  organizationOf,
  parseAzureReposRemote,
} from './azureRepos';

/** What a git network command runs with: extra environment, and the connection whose token it carries. */
export type GitAuthEnv = {
  env: Record<string, string>;
  connectionId: string | null;
};

/** Gives the environment for a network command against `remote` (whose URL is `url`) run in `cwd`. */
export type GitAuth = (o: {
  cwd: string;
  remote: string;
  url: string;
}) => Promise<GitAuthEnv>;

const NO_AUTH: GitAuthEnv = { env: {}, connectionId: null };

/**
 * The URL prefix the header is scoped to for an https Azure Repos remote: `https://dev.azure.com/<org>/` (the org
 * as the remote spells it) or `https://<org>.visualstudio.com/`; null for ssh, http and every other host.
 */
export function azureHeaderScope(url: string): string | null {
  if (!parseAzureReposRemote(url)) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'dev.azure.com') {
    const org = u.pathname.split('/').filter(Boolean)[0];
    return org ? `https://dev.azure.com/${org}/` : null;
  }
  return `https://${host}/`;
}

/** `Authorization: Basic base64(":" + pat)` for URLs under `scope`, added after any `GIT_CONFIG_COUNT` already set. */
export function extraHeaderEnv(
  scope: string,
  pat: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const n = Math.max(0, Number.parseInt(base.GIT_CONFIG_COUNT ?? '', 10) || 0);
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.${scope}.extraHeader`,
    [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
  };
}

/** The connection of the registered repo whose main checkout or task worktree is `cwd`, else null. */
export function connectionIdForPath(
  state: { repos: Repo[]; tasks: Task[] },
  cwd: string,
): string | null {
  const repo =
    state.repos.find((r) => samePath(r.path, cwd)) ??
    (() => {
      for (const t of state.tasks)
        for (const w of taskWorkspaces(t))
          if (w.worktreePath && samePath(w.worktreePath, cwd))
            return state.repos.find((r) => r.id === w.repoId);
      return undefined;
    })();
  return repo?.connectionId ?? null;
}

/**
 * The connection a brain folder's git signs in with: the brain home for a brain shared in the company's
 * organization, else the brain's own connection; null when `cwd` is not a brain folder.
 */
export function connectionIdForBrain(
  brains: Pick<Brain, 'path' | 'sharing' | 'connectionId'>[],
  cwd: string,
): string | null {
  const brain = brains.find((b) => samePath(b.path, cwd));
  if (!brain) return null;
  return brain.sharing?.home === 'company'
    ? BRAIN_HOME_CONNECTION_ID
    : brain.connectionId;
}

/**
 * The real provider: an https Azure Repos remote uses the token of the repo's own connection when it is in the
 * remote's organization, else of any connection in that organization. No connection, or a token that cannot be
 * read, runs git as before (its credential helper); the connection is still named so the user can fix its token.
 */
export function createGitAuth(deps: {
  connections: () => Pick<Connection, 'id' | 'organizationUrl' | 'project'>[];
  token: (connectionId: string) => Promise<string>;
  connectionIdFor: (cwd: string) => string | null;
  base?: NodeJS.ProcessEnv;
}): GitAuth {
  return async ({ cwd, url }) => {
    const scope = azureHeaderScope(url);
    const ref = parseAzureReposRemote(url);
    if (!scope || !ref) return NO_AUTH;
    const list = deps.connections();
    const own = deps.connectionIdFor(cwd);
    const connection =
      list.find(
        (c) => c.id === own && organizationOf(c.organizationUrl) === ref.org,
      ) ?? matchConnection(url, list);
    if (!connection) return NO_AUTH;
    let pat: string;
    try {
      pat = await deps.token(connection.id);
    } catch {
      return { env: {}, connectionId: connection.id };
    }
    if (!pat) return { env: {}, connectionId: connection.id };
    return {
      env: extraHeaderEnv(scope, pat, deps.base),
      connectionId: connection.id,
    };
  };
}
