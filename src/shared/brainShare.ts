import { z } from 'zod';
import { BrainWikiSchema } from './brain';

// BrainSharingSchema lives in brain.ts (BrainSchema uses it; this file imports brain.ts), re-exported here.
export {
  BrainSharingSchema,
  type BrainKeeper,
  type BrainSharing,
} from './brain';

/** brain/origin.json: where the brain was shared from and who keeps it. */
export const OriginSchema = z.object({
  format: z.literal(1),
  organizationUrl: z.string(),
  project: z.string(),
  name: z.string(),
  keeper: z.object({ installId: z.string(), name: z.string() }),
  sharedAt: z.string(),
});
export type Origin = z.infer<typeof OriginSchema>;

/** brain/members.json: the people who joined. */
export const MembersSchema = z.object({
  format: z.literal(1),
  members: z.array(
    z.object({ installId: z.string(), name: z.string(), joinedAt: z.string() }),
  ),
});
export type Members = z.infer<typeof MembersSchema>;

export const SHARED_FIELDS = [
  'wiki',
  'lastRefreshAt',
  'lastDigestAt',
  'templatesVersion',
] as const;
export type SharedField = (typeof SHARED_FIELDS)[number];

/** brain/shared.json: brain facts every machine shares, with a timestamp per field for the merge. */
export const SharedFactsSchema = z.object({
  format: z.literal(1),
  wiki: BrainWikiSchema.nullable(),
  lastRefreshAt: z.string().nullable(),
  lastDigestAt: z.string().nullable(),
  templatesVersion: z.number().int(),
  updatedAt: z.object({
    wiki: z.string(),
    lastRefreshAt: z.string(),
    lastDigestAt: z.string(),
    templatesVersion: z.string(),
  }),
});
export type SharedFacts = z.infer<typeof SharedFactsSchema>;

/** Just the shared fields of a brain record or a shared.json. */
export const sharedFactsOf = (
  x: Pick<SharedFacts, SharedField>,
): Pick<SharedFacts, SharedField> =>
  Object.fromEntries(SHARED_FIELDS.map((k) => [k, x[k]])) as Pick<
    SharedFacts,
    SharedField
  >;

const JOIN_PREFIX = 'shellie://join?';

export function joinLink(o: {
  organizationUrl: string;
  project: string;
  repositoryId: string;
}): string {
  return `${JOIN_PREFIX}org=${encodeURIComponent(o.organizationUrl)}&project=${encodeURIComponent(o.project)}&repo=${encodeURIComponent(o.repositoryId)}`;
}

/**
 * An https Azure DevOps organization: `https://dev.azure.com/<org>` or `https://<org>.visualstudio.com`. A join
 * link to any other host is refused, so a typed PAT never goes anywhere else.
 */
function isAzureOrganization(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port)
    return false;
  const host = u.hostname.toLowerCase();
  if (host === 'dev.azure.com')
    return u.pathname.split('/').filter(Boolean).length > 0;
  return /^[a-z0-9-]+\.visualstudio\.com$/.test(host);
}

/** The parts of a join link; null for anything else, including an organization that is not Azure DevOps over https. */
export function parseJoinLink(
  url: string,
): { organizationUrl: string; project: string; repositoryId: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'shellie:' || u.hostname !== 'join') return null;
  const organizationUrl = u.searchParams.get('org');
  const project = u.searchParams.get('project');
  const repositoryId = u.searchParams.get('repo');
  if (!organizationUrl || !project || !repositoryId) return null;
  if (!isAzureOrganization(organizationUrl)) return null;
  return { organizationUrl, project, repositoryId };
}

/** A git repo by its address: where it is, and the two names shown for it (`owner`/`name`). */
export type RepoAddress = {
  remoteUrl: string;
  host: string;
  owner: string;
  name: string;
};

const repoPath = (p: string): { owner: string; name: string } | null => {
  const parts = p.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const name = parts[parts.length - 1].replace(/\.git$/i, '');
  if (!name) return null;
  return { owner: parts.slice(0, -1).join('/'), name };
};

/**
 * A repo address a person pastes: `https://host/owner/repo[.git]`, `ssh://[user@]host/owner/repo` or
 * `user@host:owner/repo`. Null for anything else: http, an address with a password in it, a local path, an option.
 */
export function parseRepoUrl(text: string): RepoAddress | null {
  const t = text.trim();
  if (!t || t.startsWith('-') || /\s/.test(t)) return null;
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/)([^:]+)$/.exec(t);
  if (scp) {
    const at = repoPath(scp[3]);
    return at ? { remoteUrl: t, host: scp[2].toLowerCase(), ...at } : null;
  }
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'ssh:') return null;
  if (u.password || (u.protocol === 'https:' && u.username)) return null;
  if (u.search || u.hash) return null;
  const at = repoPath(decodeURIComponent(u.pathname));
  return at ? { remoteUrl: t, host: u.host.toLowerCase(), ...at } : null;
}

/** The join link of a brain shared in a repo of the person's own: `shellie://join?url=<address>`. */
export const repoJoinLink = (remoteUrl: string): string =>
  `${JOIN_PREFIX}url=${encodeURIComponent(remoteUrl)}`;

/** The repo a `shellie://join?url=…` link names, or the repo of an address pasted as it is; null for anything else. */
export function parseRepoJoin(
  text: string,
  parse: (url: string) => RepoAddress | null = parseRepoUrl,
): RepoAddress | null {
  const t = text.trim();
  if (!t.toLowerCase().startsWith('shellie:')) return parse(t);
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'shellie:' || u.hostname !== 'join') return null;
  const url = u.searchParams.get('url');
  return url ? parse(url) : null;
}

/** A `shellie://join?…` link of either kind (what the operating system hands the app). */
export const isJoinLink = (text: string): boolean =>
  parseJoinLink(text) !== null ||
  (text.trim().toLowerCase().startsWith('shellie:') &&
    parseRepoJoin(text) !== null);

/** How a repo home is recorded and shown: `https://<host>/<owner>` as the organization, the repo's name as the project. */
export const repoHomeOf = (
  a: RepoAddress,
): { organizationUrl: string; project: string } => ({
  organizationUrl: `https://${a.host}/${a.owner}`,
  project: a.name,
});

export const isKeeper = (origin: Origin, installId: string): boolean =>
  origin.keeper.installId === installId;

/** The id git sign-in uses for the brain home's token (see createGitAuth). Never a real connection's id. */
export const BRAIN_HOME_CONNECTION_ID = 'brain-home';

/** A shared brain's skills are newer than this Shellie knows: its jobs wait for an update of Shellie. */
export const NEWER_SHELLIE = "A colleague's Shellie is newer: update Shellie.";

/** Where this person's shared brains live when the company hosts them: an organization, a project and a PAT (never sent to the renderer). */
export type BrainHome = {
  organizationUrl: string;
  project: string;
  user: string | null;
};

export type BrainHomeInput = {
  organizationUrl: string;
  project: string;
  pat: string;
};

/**
 * What a join link leads to (`brain:previewJoin`): the brain's name and customer project, the person's connection for
 * that project (null: add the project first), and whether they already have a brain for it. With `needsToken` no
 * connection or brain home reaches the link's organization (then `organizationUrl` is the link's, `name` and
 * `project` are empty).
 */
export type JoinPreview = {
  name: string;
  organizationUrl: string;
  project: string;
  connectionId: string | null;
  needsToken: boolean;
  alreadyHave: boolean;
};

/** A shared brain found in a connection's project (the Join card). */
export type DiscoveredBrain = {
  repositoryId: string;
  name: string;
  joinLink: string;
};
