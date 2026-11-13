import { z } from 'zod';
import { BrainWikiSchema } from './brain';

// BrainSharingSchema lives in brain.ts (BrainSchema uses it; this file imports brain.ts), re-exported here.
export { BrainSharingSchema, type BrainSharing } from './brain';

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

const JOIN_PREFIX = 'shellie://join?';

export function joinLink(o: {
  organizationUrl: string;
  project: string;
  repositoryId: string;
}): string {
  return `${JOIN_PREFIX}org=${encodeURIComponent(o.organizationUrl)}&project=${encodeURIComponent(o.project)}&repo=${encodeURIComponent(o.repositoryId)}`;
}

/** The parts of a join link; null for anything else, including an organization that is not https. */
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
  try {
    if (new URL(organizationUrl).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { organizationUrl, project, repositoryId };
}

export const isKeeper = (origin: Origin, installId: string): boolean =>
  origin.keeper.installId === installId;

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
