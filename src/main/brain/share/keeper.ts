/**
 * The keeper of a shared brain (the shared-brains spec, "The keeper" and "Skills versions"): the one machine that runs
 * the brain-wide automatic work, the brain facts every machine shares in `brain/shared.json`, the stop for a Shellie
 * older than the brain's skills, and handing over or taking over the keeper role.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Brain } from '../../../shared/brain';
import {
  isKeeper,
  SHARED_FIELDS,
  type BrainKeeper,
  type SharedFacts,
} from '../../../shared/brainShare';
import { GitAuthError, type GitClient } from '../../services/GitClient';
import { KEEPER_MESSAGE, SHARED_FACTS_MESSAGE } from '../brainCommits';
import type { BrainStore } from '../BrainStore';
import { withBrainGit } from '../gitMutex';
import { TEMPLATES_VERSION } from '../templates';
import {
  parseOrigin,
  readMembers,
  readOrigin,
  writeOrigin,
  writeShared,
} from './files';
import { isAncestor, SERVER, succeeds } from './gitUtil';

/** A member may take over once the keeper's machine has sent nothing for this long. */
const TAKE_OVER_MS = 14 * 24 * 3600 * 1000;
export const UNREACHABLE = "Can't reach the brain's server; try again.";
const NOT_UP_TO_DATE =
  "This brain doesn't have the server's latest changes yet; try again.";

export type FactsPatch = Partial<Omit<SharedFacts, 'format' | 'updatedAt'>>;

/** Which machine made a commit: the author email a shared brain's clone is set up with at share and join. */
export const installEmail = (installId: string) =>
  `${installId}@install.shellie`;

/** Sets the clone's commit identity: the install's email (which machine made a commit) and the person's name. */
export async function setCommitIdentity(
  git: GitClient,
  dir: string,
  installId: string,
  person: string,
): Promise<void> {
  await git.run(dir, ['config', 'user.email', installEmail(installId)]);
  await git.run(dir, ['config', 'user.name', person]);
}

/**
 * Whether this machine runs the brain's automatic work: always for a local brain, for a shared one only on the
 * keeper's. Read from `brain/origin.json` each time (a small file), so a hand-over pulled in counts at once; a shared
 * brain without a readable origin runs nothing on its own.
 */
export function isAutomatic(b: Brain, installId: string): boolean {
  if (!b.sharing) return true;
  try {
    const origin = parseOrigin(
      readFileSync(path.join(b.path, 'brain', 'origin.json'), 'utf8'),
    );
    return !!origin && isKeeper(origin, installId);
  } catch {
    return false;
  }
}

/** A shared brain whose skills are newer than this Shellie knows: its jobs wait for an update of Shellie. */
export const shellieOutdated = (
  b: Pick<Brain, 'sharing' | 'templatesVersion'>,
): boolean => !!b.sharing && b.templatesVersion > TEMPLATES_VERSION;

/** On a shared brain: writes the facts to `brain/shared.json` and commits them (pushed like any brain commit). */
export async function saveSharedFacts(
  git: GitClient,
  b: Brain,
  patch: FactsPatch,
  now: Date,
): Promise<void> {
  if (!b.sharing) return;
  const dir = b.path;
  await withBrainGit(dir, async () => {
    await writeShared(dir, patch, now);
    await git.run(dir, ['add', '--', 'brain/shared.json']);
    const unchanged = await succeeds(git, dir, [
      'diff',
      '--cached',
      '--quiet',
      '--',
      'brain/shared.json',
    ]);
    if (unchanged) return;
    // Only shared.json: nothing else staged in the brain lands in this commit.
    await git.run(dir, [
      'commit',
      '-q',
      '-m',
      SHARED_FACTS_MESSAGE,
      '--',
      'brain/shared.json',
    ]);
  });
}

/**
 * Saves brain facts: to `brain/shared.json` first on a shared brain (so a pull in between copies the new value, not
 * the old one), then to the record. A shared file that could not be written leaves the record saved.
 */
export async function patchFacts(
  d: { brains: BrainStore; git: GitClient },
  id: string,
  patch: FactsPatch,
  now: Date,
): Promise<Brain> {
  const b = d.brains.get(id);
  if (!b) throw new Error(`Unknown brain ${id}`);
  await saveSharedFacts(d.git, b, patch, now).catch((e: unknown) =>
    console.error('[brain] shared facts', (e as Error).message),
  );
  return d.brains.patch(id, patch);
}

/** The record fields `shared.json` holds that differ from the brain's; null when they are the same. */
export function factsFromShared(
  b: Brain,
  shared: SharedFacts,
): FactsPatch | null {
  const out: FactsPatch = {};
  for (const key of SHARED_FIELDS)
    if (JSON.stringify(b[key]) !== JSON.stringify(shared[key]))
      Object.assign(out, { [key]: shared[key] });
  return Object.keys(out).length ? out : null;
}

/**
 * Who keeps the brain and whom they can hand over to: the members who joined and have not left, the keeper left out.
 * Null for a brain without an origin.
 */
export async function keeperOf(
  dir: string,
  installId: string,
): Promise<BrainKeeper | null> {
  const [origin, read] = await Promise.all([
    readOrigin(dir).catch(() => null),
    readMembers(dir).catch(() => null),
  ]);
  if (!origin) return null;
  const members = read?.members ?? [];
  return {
    ...origin.keeper,
    me: isKeeper(origin, installId),
    members: members
      .filter((m) => m.installId !== origin.keeper.installId)
      .map((m) => ({ installId: m.installId, name: m.name })),
  };
}

async function commitKeeper(
  git: GitClient,
  dir: string,
  keeper: { installId: string; name: string },
): Promise<void> {
  const origin = await readOrigin(dir);
  if (!origin) throw new Error('This brain is not shared');
  await writeOrigin(dir, { ...origin, keeper });
  await git.run(dir, ['add', '--', 'brain/origin.json']);
  await git.run(dir, [
    'commit',
    '-q',
    '-m',
    KEEPER_MESSAGE,
    '--',
    'brain/origin.json',
  ]);
}

/** The keeper names a colleague who has joined as the new keeper. */
export async function handOver(
  git: GitClient,
  dir: string,
  installId: string,
  target: string,
): Promise<void> {
  await withBrainGit(dir, async () => {
    const origin = await readOrigin(dir);
    if (!origin) throw new Error('This brain is not shared');
    if (!isKeeper(origin, installId))
      throw new Error('Only the keeper can hand over');
    const member = (await readMembers(dir))?.members.find(
      (m) => m.installId === target,
    );
    if (!member || target === installId)
      throw new Error('Pick a colleague who has joined this brain');
    await commitKeeper(git, dir, {
      installId: member.installId,
      name: member.name,
    });
  });
}

/**
 * The time of the keeper's newest commit on the server (told by its author email), or of the share commit (the
 * root) when it made none; null before the server has a main.
 */
async function keeperLastSent(
  git: GitClient,
  dir: string,
  keeperId: string,
): Promise<number | null> {
  if (!(await git.commitExists(dir, SERVER))) return null;
  const own = (
    await git.run(dir, [
      'log',
      '-1',
      '--format=%ct',
      '--fixed-strings',
      `--author=<${installEmail(keeperId)}>`,
      SERVER,
    ])
  ).trim();
  if (own) return Number(own) * 1000;
  const roots = (
    await git.run(dir, ['log', '--max-parents=0', '--format=%ct', SERVER])
  )
    .split('\n')
    .filter(Boolean)
    .map(Number);
  return roots.length ? Math.min(...roots) * 1000 : null;
}

/** A member becomes the keeper, once the keeper's machine has sent nothing to the server for over 14 days. */
export async function takeOver(
  git: GitClient,
  dir: string,
  installId: string,
  now: Date,
): Promise<void> {
  // The server as it is now, never a stale copy: offline, a keeper who still pushes would look gone.
  const fetched = await git
    .fetch(dir, SERVER, { unattended: true })
    .catch((e: unknown) => {
      // A refused sign-in says so; anything else is a server out of reach.
      if (e instanceof GitAuthError) throw e;
      return false;
    });
  if (!fetched) throw new Error(UNREACHABLE);
  await withBrainGit(dir, async () => {
    // The brain holds everything the server has (a pull merged it), so origin.json is the current one.
    if (!(await isAncestor(git, dir, SERVER, 'HEAD')))
      throw new Error(NOT_UP_TO_DATE);
    const origin = await readOrigin(dir);
    if (!origin) throw new Error('This brain is not shared');
    if (isKeeper(origin, installId)) return;
    const last = await keeperLastSent(git, dir, origin.keeper.installId);
    if (last === null)
      throw new Error(
        "Can't tell when the keeper last sent changes; try again",
      );
    if (now.getTime() - last <= TAKE_OVER_MS)
      throw new Error("The keeper's Shellie sent changes in the last 14 days");
    const me = (await readMembers(dir).catch(() => null))?.members.find(
      (m) => m.installId === installId,
    );
    const name =
      me?.name ??
      ((await git
        .run(dir, ['config', 'user.name'])
        .then((o) => o.trim())
        .catch(() => '')) ||
        'Shellie');
    await commitKeeper(git, dir, { installId, name });
  });
}
