/**
 * Share and stop sharing (the shared-brains spec, "Share"): a local brain becomes a repo in the chosen home, pushed
 * as one fresh commit of its tree, so sources removed or scrubbed earlier, and old blobs, never reach the server.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrainJob, BrainSharing } from '../../../shared/brain';
import { joinLink } from '../../../shared/brainShare';
import type { Connection } from '../../../shared/types';
import { AdoClient } from '../../services/AdoClient';
import type { GitClient } from '../../services/GitClient';
import type { BrainStore } from '../BrainStore';
import { withBrainGit } from '../gitMutex';
import { outsideEdits } from '../health';
import type { BrainJobRunner } from '../jobs';
import { absPath } from '../paths';
import { findSecrets } from '../secrets';
import { acquireLock, releaseLock, writeState } from '../state';
import type { BrainHomeStore } from './BrainHomeStore';
import { PRE_SHARE_REF, unquoteGitPath } from './BrainSync';

export { PRE_SHARE_REF };
import { upsertMember, writeOrigin, writeShared } from './files';

export const SHARE_MESSAGE = 'Brain: shared';
const BUSY = 'A brain job is running; try again later';
/** git's empty tree: the whole tree is compared with it to read every text file's lines at once. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** One diff reads at most this much (git's output must fit GitClient's 16 MB buffer) and this many paths. */
const CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_PATHS = 100;
const SHARE_FILES = [
  'brain/origin.json',
  'brain/members.json',
  'brain/shared.json',
  'brain/state.json',
];
const PENDING: ReadonlySet<BrainJob['status']> = new Set([
  'queued',
  'running',
  'paused',
]);

export type ShareDeps = {
  brains: BrainStore;
  git: GitClient;
  home: Pick<BrainHomeStore, 'get' | 'token'>;
  connections: {
    get(id: string): Pick<Connection, 'organizationUrl' | 'user'>;
    token(id: string): Promise<string>;
  };
  runner: Pick<BrainJobRunner, 'enqueue' | 'jobs' | 'running'>;
  installId: () => Promise<string>;
  /** The Azure DevOps client of an organization; tests pass a fake. */
  ado?: (
    organizationUrl: string,
    token: () => Promise<string>,
  ) => Pick<AdoClient, 'createRepository'>;
  now?: () => Date;
};

export type ShareResult =
  | { status: 'shared'; joinLink: string }
  | { status: 'secrets'; files: string[] }
  | { status: 'syncing' };

const realAdo: NonNullable<ShareDeps['ado']> = (org, token) =>
  new AdoClient(org, token);

/** The repo-relative files of HEAD's tree that hold a possible secret, in tree order. */
async function secretFiles(git: GitClient, dir: string): Promise<string[]> {
  const listing = await git.run(dir, [
    '-c',
    'core.quotepath=off',
    'ls-tree',
    '-r',
    '-z',
    '-l',
    'HEAD',
  ]);
  const blobs: { path: string; size: number }[] = [];
  for (const rec of listing.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [, type, , size] = rec.slice(0, tab).split(/\s+/);
    if (type === 'blob') blobs.push({ path: rec.slice(tab + 1), size: +size });
  }
  const found: string[] = [];
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const b of blobs) {
    if (b.size > CHUNK_BYTES) {
      // Too large for one diff: read from disk, where a tracked file is HEAD's unless edited since.
      const text = await fs
        .readFile(absPath(dir, b.path), 'utf8')
        .catch(() => '');
      if (!text.includes('\0') && findSecrets(text).length) found.push(b.path);
      continue;
    }
    if (chunk.length >= CHUNK_PATHS || bytes + b.size > CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(b.path);
    bytes += b.size;
  }
  if (chunk.length) chunks.push(chunk);
  for (const paths of chunks) {
    // Every line of every text file, as added since the empty tree; git leaves binary files out.
    const diff = await git.run(dir, [
      '--literal-pathspecs',
      '-c',
      'core.quotepath=off',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U0',
      EMPTY_TREE,
      'HEAD',
      '--',
      ...paths,
    ]);
    found.push(...secretsInDiff(diff));
  }
  return found;
}

/** The files a diff adds a possible secret to. */
function secretsInDiff(diff: string): string[] {
  const out: string[] = [];
  let file: string | null = null;
  let lines: string[] = [];
  let header = false;
  const check = () => {
    if (file && findSecrets(lines.join('\n')).length) out.push(file);
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      check();
      header = true;
      file = null;
      lines = [];
    } else if (header && line.startsWith('+++ ')) {
      const name = unquoteGitPath(line.slice(4).replace(/\t$/, ''));
      file = name.startsWith('b/') ? name.slice(2) : name;
    } else if (line.startsWith('@@')) {
      header = false;
    } else if (!header && file && line.startsWith('+')) {
      lines.push(line.slice(1));
    }
  }
  check();
  return out;
}

const localConfig = (git: GitClient, dir: string, key: string) =>
  git
    .run(dir, ['config', '--local', '--get', key])
    .then((v) => v.replace(/\n$/, ''))
    .catch(() => null);

/**
 * Shares the brain: creates the repo in the home, writes the share files, and pushes one fresh commit of the tree
 * (`Brain: shared`) as main; the old history stays in PRE_SHARE_REF until the first pull. Outside edits not yet
 * synced queue a `/sync` first (`syncing`: the caller asks again once it is done); a possible secret stops it
 * (`secrets`). A failure once the repo exists leaves the brain as it was, and says the empty repo can be deleted.
 */
export async function shareBrain(
  d: ShareDeps,
  i: { brainId: string; home: 'customer' | 'company'; repoName: string },
): Promise<ShareResult> {
  const now = (d.now ?? (() => new Date()))();
  const b = d.brains.get(i.brainId);
  if (!b) throw new Error(`Unknown brain ${i.brainId}`);
  if (b.sharing) throw new Error('Already shared');
  const repoName = i.repoName.trim();
  if (!repoName) throw new Error('Enter a repo name');
  const dir = b.path;
  if (d.runner.running(b.id)) throw new Error(BUSY);

  if ((await outsideEdits(dir, d.git)).length) {
    const waiting = d.runner
      .jobs(b.id)
      .some((j) => j.kind === 'sync' && PENDING.has(j.status));
    if (!waiting) d.runner.enqueue(b.id, 'sync');
    return { status: 'syncing' };
  }
  const files = await secretFiles(d.git, dir);
  if (files.length) return { status: 'secrets', files };
  if ((await d.git.remotes(dir)).includes('origin'))
    throw new Error(
      'This brain folder already has a git remote named origin; remove it first',
    );

  const connection = d.connections.get(b.connectionId);
  const company = i.home === 'company' ? d.home.get() : null;
  if (i.home === 'company' && !company)
    throw new Error('Set up the company brain home first');
  const home = company
    ? {
        organizationUrl: company.organizationUrl,
        project: company.project,
        token: () => d.home.token(),
      }
    : {
        organizationUrl: connection.organizationUrl,
        project: b.project,
        token: () => d.connections.token(b.connectionId),
      };
  const installId = await d.installId();
  const person = connection.user ?? 'Shellie';

  const repo = await (d.ado ?? realAdo)(
    home.organizationUrl,
    home.token,
  ).createRepository(home.project, repoName);

  if (!(await acquireLock(dir, process.pid, () => now).catch(() => false)))
    throw new Error(
      `${BUSY}. Nothing was shared; the empty repo ${repoName} can be deleted in Azure DevOps.`,
    );
  try {
    await withBrainGit(dir, async () => {
      const git = d.git;
      const before = (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
      const identity = {
        email: await localConfig(git, dir, 'user.email'),
        name: await localConfig(git, dir, 'user.name'),
      };
      const kept = await Promise.all(
        SHARE_FILES.map(async (rel) => ({
          rel,
          text: await fs.readFile(absPath(dir, rel), 'utf8').catch(() => null),
        })),
      );
      let remoteAdded = false;
      try {
        await git.run(dir, ['update-ref', PRE_SHARE_REF, before]);
        // Which machine made a commit is told by its author email.
        await git.run(dir, [
          'config',
          'user.email',
          `${installId}@install.shellie`,
        ]);
        await git.run(dir, ['config', 'user.name', person]);
        await writeOrigin(dir, {
          format: 1,
          organizationUrl: connection.organizationUrl,
          project: b.project,
          name: b.name,
          keeper: { installId, name: person },
          sharedAt: now.toISOString(),
        });
        // A fresh members list: an earlier share's members are not in this repo.
        await fs.rm(absPath(dir, 'brain/members.json'), { force: true });
        await upsertMember(dir, {
          installId,
          name: person,
          joinedAt: now.toISOString(),
        });
        await writeShared(
          dir,
          {
            wiki: b.wiki,
            lastRefreshAt: b.lastRefreshAt,
            lastDigestAt: b.lastDigestAt,
            templatesVersion: b.templatesVersion,
          },
          now,
        );
        // The old history's commits are not in the shared one; null makes /sync start from its first commit, the share.
        await writeState(dir, (s) => ({ ...s, lastSyncCommit: null }));
        // HEAD's tree plus the share files, built in an index of its own: the person's staged work stays out.
        const index = path.resolve(
          dir,
          (
            await git.run(dir, [
              'rev-parse',
              '--git-path',
              'shellie-share-index',
            ])
          ).trim(),
        );
        let tree: string;
        try {
          const env = { GIT_INDEX_FILE: index };
          await git.run(dir, ['read-tree', 'HEAD'], { env });
          await git.run(dir, ['add', '--', ...SHARE_FILES], { env });
          tree = (await git.run(dir, ['write-tree'], { env })).trim();
        } finally {
          await fs.rm(index, { force: true });
        }
        const shared = (
          await git.run(dir, ['commit-tree', tree, '-m', SHARE_MESSAGE])
        ).trim();
        await git.run(dir, ['reset', '-q', shared]);
        await git.run(dir, ['remote', 'add', 'origin', repo.remoteUrl]);
        remoteAdded = true;
        await git.push(dir, 'origin', 'HEAD:main');
        const sharing: BrainSharing = {
          home: i.home,
          remoteUrl: repo.remoteUrl,
          repositoryId: repo.id,
          homeOrganizationUrl: home.organizationUrl,
          homeProject: home.project,
          joinedAt: now.toISOString(),
          lastPullAt: null,
          lastPushAt: now.toISOString(),
          status: 'ok',
          heldFile: null,
        };
        await d.brains.patch(b.id, { sharing });
      } catch (e) {
        await restore(git, dir, {
          before,
          identity,
          kept,
          remoteAdded,
        }).catch((r: unknown) =>
          console.error('[brain] share restore failed', (r as Error).message),
        );
        throw e;
      }
    });
  } catch (e) {
    throw new Error(
      `${(e as Error).message.replace(/\.?\s*$/, '')}. Nothing was shared; the empty repo ${repoName} can be deleted in Azure DevOps.`,
    );
  } finally {
    await releaseLock(dir).catch(() => undefined);
  }
  return {
    status: 'shared',
    joinLink: joinLink({
      organizationUrl: home.organizationUrl,
      project: home.project,
      repositoryId: repo.id,
    }),
  };
}

/** Puts the brain back as it was before a share that failed: its branch, files, identity, no remote. */
async function restore(
  git: GitClient,
  dir: string,
  was: {
    before: string;
    identity: { email: string | null; name: string | null };
    kept: { rel: string; text: string | null }[];
    remoteAdded: boolean;
  },
): Promise<void> {
  if (was.remoteAdded) await git.run(dir, ['remote', 'remove', 'origin']);
  const now = (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
  if (now !== was.before) await git.run(dir, ['reset', '-q', was.before]);
  for (const f of was.kept) {
    const file = absPath(dir, f.rel);
    if (f.text === null) await fs.rm(file, { force: true });
    else await fs.writeFile(file, f.text, 'utf8');
  }
  for (const [key, value] of [
    ['user.email', was.identity.email],
    ['user.name', was.identity.name],
  ] as const) {
    if (value !== null) await git.run(dir, ['config', key, value]);
    else await git.run(dir, ['config', '--unset', key]).catch(() => undefined);
  }
  await git.run(dir, ['update-ref', '-d', PRE_SHARE_REF]);
}

/** Stops sharing: the brain keeps its folder and history (origin.json too) and becomes local again. */
export async function stopSharing(
  d: Pick<ShareDeps, 'brains' | 'git'>,
  brainId: string,
): Promise<void> {
  const b = d.brains.get(brainId);
  if (!b) throw new Error(`Unknown brain ${brainId}`);
  if (!b.sharing) return;
  await withBrainGit(b.path, async () => {
    if ((await d.git.remotes(b.path)).includes('origin'))
      await d.git.run(b.path, ['remote', 'remove', 'origin']);
  });
  await d.brains.patch(brainId, { sharing: null });
}
