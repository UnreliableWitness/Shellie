/**
 * Share and stop sharing (the shared-brains spec, "Share"): a local brain becomes a repo in the chosen home, pushed
 * as one fresh commit of its tree, so sources removed or scrubbed earlier, and old blobs, never reach the server.
 */
import fs from 'node:fs/promises';
import type { BrainSharing } from '../../../shared/brain';
import { isKeeper, joinLink, sharedFactsOf } from '../../../shared/brainShare';
import type { Connection } from '../../../shared/types';
import { AdoClient } from '../../services/AdoClient';
import type { GitClient } from '../../services/GitClient';
import { PENDING } from '../bookPass';
import type { BrainStore } from '../BrainStore';
import { withBrainGit } from '../gitMutex';
import { isSyncCommit, outsideEdits } from '../health';
import type { BrainJobRunner } from '../jobs';
import { absPath } from '../paths';
import { READS_RECORD } from '../reads';
import { readState, withBrainLock, writeState } from '../state';
import type { BrainHomeStore } from './BrainHomeStore';
import { PRE_SHARE_REF, type BrainSync } from './BrainSync';
import {
  readOrigin,
  removeMember,
  upsertMember,
  writeOrigin,
  writeShared,
} from './files';
import {
  headOf,
  mapReadCommits,
  parseJsonOrNull,
  succeeds,
  withPrivateIndex,
} from './gitUtil';
import { setCommitIdentity } from './keeper';
import { CHUNK_BYTES, treeSecretFiles } from './secretScan';

export const SHARE_MESSAGE = 'Brain: shared';
export const LEAVE_MESSAGE = 'Brain: left';
const BUSY = 'A brain job is running; try again later';
const SHARE_FILES = [
  'brain/origin.json',
  'brain/members.json',
  'brain/shared.json',
  'brain/state.json',
];

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
  /** Blobs read together per diff, and the size over which one is read on its own (tests make it small). */
  scanChunkBytes?: number;
};

export type ShareResult =
  | { status: 'shared'; joinLink: string }
  | { status: 'secrets'; files: string[] }
  | { status: 'syncing' };

const realAdo: NonNullable<ShareDeps['ado']> = (org, token) =>
  new AdoClient(org, token);

/**
 * True when a /sync must run before the share: outside edits Health lists, or commits to sources/ or wiki/ since
 * `lastSyncCommit` other than a /sync's own (any capture at all when there is none). The shared history starts
 * afresh, so /sync could not see those changes later.
 */
async function needsSync(git: GitClient, dir: string): Promise<boolean> {
  if ((await outsideEdits(dir, git)).length) return true;
  const { state } = await readState(dir);
  const last = state?.lastSyncCommit ?? null;
  if (!last) return Object.keys(state?.captured ?? {}).length > 0;
  const log = await git
    .run(dir, [
      'log',
      '--format=%s',
      `${last}..HEAD`,
      '--',
      'sources/',
      'wiki/',
    ])
    .catch(() => null);
  // A lastSyncCommit git does not know: a /sync sets a good one.
  if (log === null) return true;
  return log
    .split('\n')
    .some((subject) => subject.trim() && !isSyncCommit(subject));
}

const localConfig = (git: GitClient, dir: string, key: string) =>
  git
    .run(dir, ['config', '--local', '--get', key])
    .then((v) => v.replace(/\n$/, ''))
    .catch(() => null);

/**
 * Shares the brain: creates the repo in the home, writes the share files, and pushes one fresh commit of the tree
 * (`Brain: shared`) as main; the old history stays in PRE_SHARE_REF until the first pull. Changes /sync has not
 * seen queue a `/sync` first (`syncing`: the caller asks again once it is done); a possible secret stops it
 * (`secrets`). A commit made during the share is checked again before anything is written. A failure once the repo
 * exists leaves the brain as it was, and says the empty repo can be deleted.
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

  const chunkBytes = d.scanChunkBytes ?? CHUNK_BYTES;
  if (await needsSync(d.git, dir)) {
    const waiting = d.runner
      .jobs(b.id)
      .some((j) => j.kind === 'sync' && PENDING.has(j.status));
    if (!waiting) d.runner.enqueue(b.id, 'sync');
    return { status: 'syncing' };
  }
  const scanned = await headOf(d.git, dir);
  const files = await treeSecretFiles(d.git, dir, scanned, chunkBytes);
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

  const nothingShared = `Nothing was shared; the empty repo ${repoName} can be deleted in Azure DevOps.`;
  await withBrainLock(
    dir,
    () =>
      withBrainGit(dir, async () => {
        const git = d.git;
        const before = await headOf(git, dir);
        // A commit made since the checks (a source added meanwhile) is checked too, before anything is written.
        if (
          before !== scanned &&
          ((await needsSync(git, dir)) ||
            (await treeSecretFiles(git, dir, before, chunkBytes)).length)
        )
          throw new Error(
            'The brain changed while it was being shared; share again',
          );
        const identity = {
          email: await localConfig(git, dir, 'user.email'),
          name: await localConfig(git, dir, 'user.name'),
        };
        const kept = await Promise.all(
          [...SHARE_FILES, READS_RECORD].map(async (rel) => ({
            rel,
            text: await fs
              .readFile(absPath(dir, rel), 'utf8')
              .catch(() => null),
          })),
        );
        let remoteAdded = false;
        let recorded = false;
        try {
          await git.run(dir, ['update-ref', PRE_SHARE_REF, before]);
          await setCommitIdentity(git, dir, installId, person);
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
          await writeShared(dir, sharedFactsOf(b), now);
          // The old history's commits are not in the shared one; null makes /sync start from its first commit, the share.
          await writeState(dir, (s) => ({ ...s, lastSyncCommit: null }));
          // Likewise a long read's commit: null makes /write update compare with the share commit (the file's last).
          const reads = await movedReads(dir);
          const toAdd = reads ? [...SHARE_FILES, READS_RECORD] : SHARE_FILES;
          // HEAD's tree plus the share files, built in an index of its own: the person's staged work stays out.
          const tree = await withPrivateIndex(
            git,
            dir,
            'shellie-share-index',
            before,
            async (env) => {
              await git.run(dir, ['add', '--', ...toAdd], { env });
            },
          );
          const shared = (
            await git.run(dir, ['commit-tree', tree, '-m', SHARE_MESSAGE])
          ).trim();
          await git.run(dir, ['reset', '-q', shared]);
          await git.run(dir, ['remote', 'add', 'origin', repo.remoteUrl]);
          remoteAdded = true;
          const sharing: BrainSharing = {
            home: i.home,
            remoteUrl: repo.remoteUrl,
            repositoryId: repo.id,
            homeOrganizationUrl: home.organizationUrl,
            homeProject: home.project,
            joinedAt: now.toISOString(),
            lastPullAt: null,
            lastPushAt: null,
            status: 'pending',
            heldFile: null,
          };
          // Recorded before the push: git signs in by the brain's home (connectionIdForBrain), the brain home's token
          // for the company home. The brain lock keeps BrainSync's pulls out meanwhile.
          await d.brains.patch(b.id, { sharing });
          recorded = true;
          await git.push(dir, 'origin', 'HEAD:main');
          await d.brains.patch(b.id, {
            sharing: {
              ...sharing,
              status: 'ok',
              lastPushAt: now.toISOString(),
            },
          });
        } catch (e) {
          if (recorded)
            await d.brains
              .patch(b.id, { sharing: null })
              .catch((r: unknown) =>
                console.error(
                  '[brain] share restore failed',
                  (r as Error).message,
                ),
              );
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
      }).catch((e: unknown) => {
        throw new Error(
          `${(e as Error).message.replace(/\.?\s*$/, '')}. ${nothingShared}`,
        );
      }),
    {
      now: () => now,
      busy: () => {
        throw new Error(`${BUSY}. ${nothingShared}`);
      },
    },
  );
  return {
    status: 'shared',
    joinLink: joinLink({
      organizationUrl: home.organizationUrl,
      project: home.project,
      repositoryId: repo.id,
    }),
  };
}

/**
 * `brain/reads.json` with every long read's `commit` set to null (unknown keys kept); false when there is no record
 * or it cannot be read, and then it is left as it is.
 */
async function movedReads(dir: string): Promise<boolean> {
  const file = absPath(dir, READS_RECORD);
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) return false;
  const value = parseJsonOrNull(text);
  if (mapReadCommits(value, () => null) === null) return false;
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return true;
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
  const now = await headOf(git, dir);
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

/**
 * A member leaves a shared brain (the spec, "Leaving and stopping"): their line in `brain/members.json` is taken out
 * by a last commit, sent when the server is reachable (a push that fails or is held leaves it there), and the brain
 * becomes local on this machine, so an archived copy never syncs again. The caller then archives or deletes it. The
 * keeper is refused: they hand over first, or stop sharing.
 */
export async function leaveBrain(
  d: Pick<ShareDeps, 'brains' | 'git' | 'installId'> & {
    sync?: Pick<BrainSync, 'push'>;
  },
  brainId: string,
): Promise<void> {
  const b = d.brains.get(brainId);
  if (!b) throw new Error(`Unknown brain ${brainId}`);
  if (!b.sharing) return;
  const dir = b.path;
  const installId = await d.installId();
  const origin = await readOrigin(dir).catch(() => null);
  if (origin && isKeeper(origin, installId))
    throw new Error('You keep this brain: hand over first, or stop sharing');
  const committed = await withBrainGit(dir, async () => {
    await removeMember(dir, installId);
    const rel = 'brain/members.json';
    const tracked = await succeeds(d.git, dir, [
      'ls-files',
      '--error-unmatch',
      '--',
      rel,
    ]);
    if (!tracked) return false;
    if (await succeeds(d.git, dir, ['diff', '--quiet', '--', rel]))
      return false;
    await d.git.run(dir, ['add', '--', rel]);
    await d.git.run(dir, ['commit', '-q', '-m', LEAVE_MESSAGE, '--', rel]);
    return true;
  });
  // Never throws: offline, the line stays on the server and the person still leaves.
  if (committed) await d.sync?.push(brainId);
  await stopSharing(d, brainId);
}
