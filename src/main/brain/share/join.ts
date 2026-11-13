/**
 * Join (the shared-brains spec, "Join"): a colleague opens a `shellie://join?…` link, or the card of a brain in their
 * customer project, and Shellie clones the shared brain and records it on their own connection.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BrainSchema,
  type Brain,
  type BrainSharing,
} from '../../../shared/brain';
import {
  joinLink,
  OriginSchema,
  parseJoinLink,
  type DiscoveredBrain,
  type JoinPreview,
  type Origin,
} from '../../../shared/brainShare';
import { isGitAuthFailure } from '../../../shared/gitAuth';
import type { Connection } from '../../../shared/types';
import { AdoClient, AdoError } from '../../services/AdoClient';
import { organizationOf } from '../../services/azureRepos';
import { GitError, type GitClient } from '../../services/GitClient';
import { azureHeaderScope, extraHeaderEnv } from '../../services/gitAuth';
import type { BrainStore } from '../BrainStore';
import { withBrainGit } from '../gitMutex';
import { isBrainFolder } from '../scaffold';
import type { BrainHomeStore } from './BrainHomeStore';
import { readShared, upsertMember } from './files';

export const JOIN_MESSAGE = 'Brain: joined';
const ORIGIN_PATH = '/brain/origin.json';
/** A clone no one watches gives up after this long (a credential prompt may be waiting). */
const CLONE_TIMEOUT_MS = 10 * 60_000;

type JoinConnection = Pick<
  Connection,
  'id' | 'organizationUrl' | 'project' | 'user'
>;

export type JoinAdo = Pick<
  AdoClient,
  'itemText' | 'repositoryById' | 'repositories'
>;

export type JoinDeps = {
  brains: BrainStore;
  git: GitClient;
  home: Pick<BrainHomeStore, 'get' | 'save' | 'token'>;
  connections: {
    list(): JoinConnection[];
    token(id: string): Promise<string>;
  };
  userData: string;
  installId: () => Promise<string>;
  /** The Azure DevOps client of an organization; tests pass a fake. */
  ado?: (organizationUrl: string, token: () => Promise<string>) => JoinAdo;
  now?: () => Date;
};

/** What `discoverCustomerBrains` found per connection this app session (a failed look is not kept). */
export type DiscoverCache = Map<string, Promise<DiscoveredBrain[]>>;

const realAdo: NonNullable<JoinDeps['ado']> = (org, token) =>
  new AdoClient(org, token);

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameOrg = (a: string, b: string) => {
  const x = organizationOf(a);
  return x !== null && x === organizationOf(b);
};

/** The person's connection for the brain's customer organization and project, or null. */
const connectionFor = (d: JoinDeps, origin: Origin) =>
  d.connections
    .list()
    .find(
      (c) =>
        sameOrg(c.organizationUrl, origin.organizationUrl) &&
        sameName(c.project, origin.project),
    ) ?? null;

/** A live brain of that connection and project: merging two brains is not offered, so it blocks the join. */
const haveBrain = (d: JoinDeps, connectionId: string, project: string) =>
  d.brains
    .list()
    .some(
      (b) =>
        !b.archived &&
        b.connectionId === connectionId &&
        sameName(b.project, project),
    );

/** The token for the link's organization: one typed at the link, a connection there, or the brain home. */
function tokenFor(
  d: JoinDeps,
  link: { organizationUrl: string; project: string },
  pat: string | undefined,
): (() => Promise<string>) | null {
  const typed = pat?.trim();
  if (typed) return async () => typed;
  const inOrg = d.connections
    .list()
    .filter((c) => sameOrg(c.organizationUrl, link.organizationUrl));
  const c =
    inOrg.find((x) => sameName(x.project, link.project)) ?? inOrg[0] ?? null;
  if (c) return () => d.connections.token(c.id);
  const home = d.home.get();
  if (home && sameOrg(home.organizationUrl, link.organizationUrl))
    return () => d.home.token();
  return null;
}

const denied = (origin: Origin, path: string, status?: number) =>
  new AdoError(
    'unauthorized',
    path,
    `You don't have access to this brain; ask ${origin.keeper.name}`,
    status,
  );

type Inspected =
  | { needsToken: true; link: { organizationUrl: string } }
  | {
      needsToken: false;
      link: { organizationUrl: string; project: string; repositoryId: string };
      token: () => Promise<string>;
      origin: Origin;
      repo: Awaited<ReturnType<JoinAdo['repositoryById']>>;
      connection: JoinConnection | null;
      alreadyHave: boolean;
    };

async function inspect(
  d: JoinDeps,
  url: string,
  pat: string | undefined,
): Promise<Inspected> {
  const link = parseJoinLink(url);
  if (!link) throw new Error('This is not a Shellie join link');
  const token = tokenFor(d, link, pat);
  if (!token) return { needsToken: true, link };
  const ado = (d.ado ?? realAdo)(link.organizationUrl, token);
  // A 401/403 here is Azure DevOps's own words: the keeper is not known yet.
  const text = await ado.itemText(link.project, link.repositoryId, ORIGIN_PATH);
  if (text === null) throw new Error('This repo holds no shared brain');
  let origin: Origin;
  try {
    origin = OriginSchema.parse(JSON.parse(text));
  } catch {
    throw new Error("This brain's origin.json could not be read");
  }
  let repo: Awaited<ReturnType<JoinAdo['repositoryById']>>;
  try {
    repo = await ado.repositoryById(link.repositoryId);
  } catch (e) {
    if (e instanceof AdoError && e.kind === 'unauthorized')
      throw denied(origin, e.path, e.status);
    throw e;
  }
  const connection = connectionFor(d, origin);
  return {
    needsToken: false,
    link,
    token,
    origin,
    repo,
    connection,
    alreadyHave: connection
      ? haveBrain(d, connection.id, origin.project)
      : false,
  };
}

/**
 * What a join link leads to: the brain's name and customer project (from its origin.json), the person's connection
 * for that project (null: they add the project first), and whether they already have a brain for it. `needsToken`:
 * no connection or brain home reaches the link's organization (`organizationUrl` is then the link's), so the
 * person types a PAT and asks again with it. A refusal names the keeper once origin.json was read.
 */
export async function previewJoin(
  d: JoinDeps,
  link: string,
  o: { pat?: string } = {},
): Promise<JoinPreview> {
  const i = await inspect(d, link, o.pat);
  if (i.needsToken)
    return {
      name: '',
      organizationUrl: i.link.organizationUrl,
      project: '',
      connectionId: null,
      needsToken: true,
      alreadyHave: false,
    };
  return {
    name: i.origin.name,
    organizationUrl: i.origin.organizationUrl,
    project: i.origin.project,
    connectionId: i.connection?.id ?? null,
    needsToken: false,
    alreadyHave: i.alreadyHave,
  };
}

/** Joins at most once at a time per connection and project. */
const joining = new Set<string>();

/**
 * Joins the brain: clones it into `<userData>/brains/<new id>`, adds the person to members.json and commits
 * `Brain: joined` (BrainSync pushes it once the record exists), then records the brain on the person's connection
 * with the shared facts and default options. A typed `pat` becomes the brain home when there is none. Any failure
 * removes the clone and records nothing.
 */
export async function joinBrain(
  d: JoinDeps,
  link: string,
  o: { pat?: string } = {},
): Promise<Brain> {
  const i = await inspect(d, link, o.pat);
  if (i.needsToken)
    throw new Error(
      `Enter a personal access token for ${i.link.organizationUrl}`,
    );
  const { origin, repo, connection } = i;
  if (!connection)
    throw new Error(`Add the ${origin.project} project in Shellie first`);
  if (i.alreadyHave)
    throw new Error('You already have a brain for this project');
  const key = `${connection.id}\n${origin.project.toLowerCase()}`;
  if (joining.has(key)) throw new Error('This brain is being joined already');
  joining.add(key);
  const now = (d.now ?? (() => new Date()))();
  const id = randomUUID();
  const parent = path.join(d.userData, 'brains');
  const dir = path.join(parent, id);
  try {
    await fs.mkdir(parent, { recursive: true });
    await clone(d.git, parent, dir, repo.remoteUrl, i.token, origin);
    if (!(await isBrainFolder(dir)))
      throw new Error('This repo is not a brain');
    const shared = await readShared(dir);
    const installId = await d.installId();
    const person = connection.user ?? 'Shellie';
    const typed = o.pat?.trim();
    if (typed && !d.home.get())
      await d.home.save({
        organizationUrl: i.link.organizationUrl,
        project: i.link.project,
        pat: typed,
      });
    const home: BrainSharing['home'] =
      sameOrg(i.link.organizationUrl, origin.organizationUrl) &&
      sameName(i.link.project, origin.project)
        ? 'customer'
        : 'company';
    const brain = BrainSchema.parse({
      id,
      name: origin.name,
      connectionId: connection.id,
      project: origin.project,
      path: dir,
      wiki: shared?.wiki ?? null,
      templatesVersion: shared?.templatesVersion ?? 0,
      lastRefreshAt: shared?.lastRefreshAt ?? null,
      lastDigestAt: shared?.lastDigestAt ?? null,
      createdAt: now.toISOString(),
      sharing: {
        home,
        remoteUrl: repo.remoteUrl,
        repositoryId: repo.id,
        homeOrganizationUrl: i.link.organizationUrl,
        homeProject: repo.project,
        joinedAt: now.toISOString(),
        lastPullAt: null,
        lastPushAt: null,
        status: 'pending',
        heldFile: null,
      },
    });
    await withBrainGit(dir, async () => {
      // Which machine made a commit is told by its author email.
      await d.git.run(dir, [
        'config',
        'user.email',
        `${installId}@install.shellie`,
      ]);
      await d.git.run(dir, ['config', 'user.name', person]);
      await upsertMember(dir, {
        installId,
        name: person,
        joinedAt: now.toISOString(),
      });
      await d.git.run(dir, ['add', '--', 'brain/members.json']);
      await d.git.run(dir, ['commit', '-q', '-m', JOIN_MESSAGE]);
      if (haveBrain(d, connection.id, origin.project))
        throw new Error('You already have a brain for this project');
      // Recorded last, inside the git queue: BrainSync's push after it finds a shared brain.
      await d.brains.add(brain);
    });
    return brain;
  } catch (e) {
    await fs
      .rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      .catch((r: unknown) =>
        console.error('[brain] join cleanup failed', (r as Error).message),
      );
    throw e;
  } finally {
    joining.delete(key);
  }
}

/** Clones `remoteUrl` into `dir`, signed in with `token` through git's environment (never its command line). */
async function clone(
  git: GitClient,
  cwd: string,
  dir: string,
  remoteUrl: string,
  token: () => Promise<string>,
  origin: Origin,
): Promise<void> {
  const scope = azureHeaderScope(remoteUrl);
  const env = scope ? extraHeaderEnv(scope, await token()) : {};
  try {
    await git.run(cwd, ['clone', '--quiet', '--', remoteUrl, dir], {
      env,
      timeoutMs: CLONE_TIMEOUT_MS,
    });
  } catch (e) {
    if (e instanceof GitError && isGitAuthFailure(e.stderr))
      throw denied(origin, 'clone');
    throw e;
  }
}

/**
 * The shared brains of a connection's project: its repos with a brain/origin.json naming that organization and
 * project. Kept in `cache` for the app session; `refresh` looks again (the Project page opening).
 */
export function discoverCustomerBrains(
  d: Pick<JoinDeps, 'connections' | 'ado'>,
  connectionId: string,
  o: { cache: DiscoverCache; refresh?: boolean },
): Promise<DiscoveredBrain[]> {
  const kept = o.refresh ? undefined : o.cache.get(connectionId);
  if (kept) return kept;
  const found = discover(d, connectionId);
  o.cache.set(connectionId, found);
  found.catch(() => {
    if (o.cache.get(connectionId) === found) o.cache.delete(connectionId);
  });
  return found;
}

async function discover(
  d: Pick<JoinDeps, 'connections' | 'ado'>,
  connectionId: string,
): Promise<DiscoveredBrain[]> {
  const c = d.connections.list().find((x) => x.id === connectionId);
  if (!c) throw new Error(`Unknown connection ${connectionId}`);
  const ado = (d.ado ?? realAdo)(c.organizationUrl, () =>
    d.connections.token(c.id),
  );
  const repos = await ado.repositories(c.project);
  const found = await Promise.all(
    repos.map(async (r): Promise<DiscoveredBrain | null> => {
      // A repo that cannot be read, or holds no brain, is simply not one.
      const text = await ado
        .itemText(c.project, r.id, ORIGIN_PATH)
        .catch(() => null);
      if (text === null) return null;
      let origin: Origin;
      try {
        origin = OriginSchema.parse(JSON.parse(text));
      } catch {
        return null;
      }
      if (
        !sameOrg(origin.organizationUrl, c.organizationUrl) ||
        !sameName(origin.project, c.project)
      )
        return null;
      return {
        repositoryId: r.id,
        name: origin.name,
        joinLink: joinLink({
          organizationUrl: c.organizationUrl,
          project: c.project,
          repositoryId: r.id,
        }),
      };
    }),
  );
  return found.filter((x): x is DiscoveredBrain => x !== null);
}
