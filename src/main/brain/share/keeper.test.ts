import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainSchema, type Brain, type BrainJob } from '../../../shared/brain';
import { GitClient } from '../../services/GitClient';
import { BrainStore } from '../BrainStore';
import { commitJobOutput, OUTSIDE_EDIT_MESSAGE } from '../brainHandlers';
import { scaffoldBrain } from '../scaffold';
import { startBrainScheduler } from '../scheduler';
import { TEMPLATES_VERSION } from '../templates';
import { BrainSync, type SyncRunner } from './BrainSync';
import {
  readOrigin,
  readShared,
  upsertMember,
  writeOrigin,
  writeShared,
} from './files';
import { KEEPER_MESSAGE, SHARED_FACTS_MESSAGE } from '../brainCommits';
import {
  handOver,
  isAutomatic,
  keeperOf,
  patchFacts,
  shellieOutdated,
  takeOver,
  UNREACHABLE,
} from './keeper';

// real git, many subprocesses per test: slow under load and on the Windows runner
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const git = new GitClient();
const DAY = 24 * 3600 * 1000;
const KEEPER = 'install-k';
const MEMBER = 'install-m';
/** The share commit (the repo's root) was made then. */
const SHARED_AT = '2026-10-01T12:00:00.000Z';

let root: string;
let server: string;
let a: string;
let b: string;
let brains: BrainStore;

let released: string[];
const runner: SyncRunner = {
  enqueue: () => ({}) as BrainJob,
  jobs: () => [],
  running: () => false,
  fail: () => true,
  release: (id) => {
    released.push(id);
  },
};
const sync = () =>
  new BrainSync({
    brains,
    git,
    runner: () => runner,
    changed: () => undefined,
    commitOutsideEdits: (id) =>
      commitJobOutput(
        git,
        brains.get(id)?.path ?? '',
        OUTSIDE_EDIT_MESSAGE,
        'Acme',
      ),
  });
const subject = async (dir: string) =>
  (await git.run(dir, ['log', '-1', '--format=%s'])).trim();
const record = (id: string): Brain => {
  const x = brains.get(id);
  if (!x) throw new Error(id);
  return x;
};

const brainRecord = (id: string, dir: string, over: Partial<Brain> = {}) =>
  BrainSchema.parse({
    id,
    name: 'Acme',
    connectionId: 'c',
    project: 'p',
    path: dir,
    createdAt: SHARED_AT,
    templatesVersion: TEMPLATES_VERSION,
    options: { weeklyDigest: true },
    sharing: {
      home: 'company',
      remoteUrl: server,
      repositoryId: 'r',
      homeOrganizationUrl: 'https://dev.azure.com/o',
      homeProject: 'p',
      joinedAt: SHARED_AT,
      lastPullAt: null,
      lastPushAt: null,
      status: 'ok',
      heldFile: null,
    },
    ...over,
  });

beforeEach(async () => {
  released = [];
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-keeper-'));
  const seed = path.join(root, 'seed');
  server = path.join(root, 'server.git');
  await scaffoldBrain(git, seed, 'Acme');
  await writeOrigin(seed, {
    format: 1,
    organizationUrl: 'https://dev.azure.com/o',
    project: 'p',
    name: 'Acme',
    keeper: { installId: KEEPER, name: 'Dries' },
    sharedAt: SHARED_AT,
  });
  for (const [installId, name] of [
    [KEEPER, 'Dries'],
    [MEMBER, 'Ann'],
  ])
    await upsertMember(seed, { installId, name, joinedAt: SHARED_AT });
  await writeShared(
    seed,
    {
      wiki: null,
      lastRefreshAt: null,
      lastDigestAt: null,
      templatesVersion: TEMPLATES_VERSION,
    },
    new Date(SHARED_AT),
  );
  // One root commit, as a share makes it, dated SHARED_AT.
  await git.run(seed, ['add', '-A']);
  await git.run(seed, ['commit', '-q', '--amend', '--no-edit'], {
    env: { GIT_COMMITTER_DATE: SHARED_AT, GIT_AUTHOR_DATE: SHARED_AT },
  });
  await git.run(root, ['init', '-q', '--bare', '-b', 'main', server]);
  await git.run(seed, ['remote', 'add', 'origin', server]);
  await git.run(seed, ['push', '-q', 'origin', 'main']);
  a = path.join(root, 'a');
  b = path.join(root, 'b');
  for (const [dir, installId, name] of [
    [a, KEEPER, 'Dries'],
    [b, MEMBER, 'Ann'],
  ]) {
    await git.run(root, ['clone', '-q', server, dir]);
    await git.run(dir, ['config', 'user.name', name]);
    await git.run(dir, [
      'config',
      'user.email',
      `${installId}@install.shellie`,
    ]);
  }
  brains = new BrainStore(path.join(root, 'brains.json'));
  await brains.load();
  await brains.add(brainRecord('a', a));
  await brains.add(brainRecord('b', b));
});

afterEach(async () => {
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

describe('the keeper', () => {
  it('runs automatic work only on the keeper, and on any local brain', async () => {
    expect(isAutomatic(record('a'), KEEPER)).toBe(true);
    expect(isAutomatic(record('b'), MEMBER)).toBe(false);
    expect(isAutomatic(brainRecord('l', b, { sharing: null }), MEMBER)).toBe(
      true,
    );
  });

  it("shares the keeper's digest date, so a later keeper never digests twice that week", async () => {
    // Monday 2026-11-09, 09:00 local.
    const digestAt = new Date(2026, 10, 9, 9, 0);
    await patchFacts(
      { brains, git },
      'a',
      { lastDigestAt: digestAt.toISOString() },
      digestAt,
    );
    expect(record('a').lastDigestAt).toBe(digestAt.toISOString());
    expect((await readShared(a))?.lastDigestAt).toBe(digestAt.toISOString());
    expect(await subject(a)).toBe(SHARED_FACTS_MESSAGE);

    await sync().push('a');
    await sync().pull('b');
    expect(record('b').lastDigestAt).toBe(digestAt.toISOString());

    await handOver(git, a, KEEPER, MEMBER);
    await sync().push('a');
    await sync().pull('b');
    expect((await readOrigin(b))?.keeper).toEqual({
      installId: MEMBER,
      name: 'Ann',
    });
    expect(isAutomatic(record('b'), MEMBER)).toBe(true);

    // Wednesday of that week on the new keeper's machine.
    const digest: string[] = [];
    const stop = startBrainScheduler({
      brains: () => [record('b')],
      refresh: async () => undefined,
      digest: (id) => digest.push(id),
      running: () => false,
      picturePass: async () => undefined,
      passRunning: () => false,
      bookPass: async () => undefined,
      bookPassRunning: () => false,
      readsPass: async () => undefined,
      readsPassRunning: () => false,
      automatic: (id) => isAutomatic(record(id), MEMBER),
      now: () => new Date(2026, 10, 11, 9, 0),
      tick: 60_000,
    });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(digest).toEqual([]);
  });

  it('copies the wiki link and refresh date from the server on a pull', async () => {
    const wiki = {
      wikiId: 'w',
      wikiName: 'w',
      type: 'projectWiki' as const,
      repositoryId: 'r',
      gitUrl: 'https://dev.azure.com/o/p/_git/p.wiki',
      version: 'wikiMaster',
      mappedPath: '/',
      rootPath: '/',
    };
    const at = '2026-11-10T08:00:00.000Z';
    await patchFacts(
      { brains, git },
      'a',
      { wiki, lastRefreshAt: at },
      new Date(at),
    );
    await sync().push('a');
    await sync().pull('b');
    expect(record('b').wiki).toEqual(wiki);
    expect(record('b').lastRefreshAt).toBe(at);
  });

  it("stops a member's jobs when a colleague's Shellie knows newer skills; its pulls still work", async () => {
    await patchFacts(
      { brains, git },
      'a',
      { templatesVersion: TEMPLATES_VERSION + 1 },
      new Date(),
    );
    await fs.writeFile(path.join(a, 'sources', 'n.md'), 'a note\n');
    await git.run(a, ['add', '-A']);
    await git.run(a, ['commit', '-q', '-m', 'Brain: add source n.md']);
    await sync().push('a');
    expect(shellieOutdated(record('b'))).toBe(false);
    await sync().pull('b');
    expect(record('b').templatesVersion).toBe(TEMPLATES_VERSION + 1);
    expect(shellieOutdated(record('b'))).toBe(true);
    expect(record('b').sharing?.status).toBe('ok');
    // The runner checks again: still not ready, its jobs stay held.
    expect(released).toEqual(['b']);
    // The next pull still merges the server's changes.
    await fs.writeFile(path.join(a, 'sources', 'm.md'), 'another\n');
    await git.run(a, ['add', '-A']);
    await git.run(a, ['commit', '-q', '-m', 'Brain: add source m.md']);
    await sync().push('a');
    await sync().pull('b');
    await expect(
      fs.readFile(path.join(b, 'sources', 'm.md'), 'utf8'),
    ).resolves.toBe('another\n');
    expect(record('b').sharing?.status).toBe('ok');
  });

  it('hands over only from the keeper and only to a member', async () => {
    await expect(handOver(git, a, KEEPER, 'install-x')).rejects.toThrow(
      'Pick a colleague who has joined this brain',
    );
    await expect(handOver(git, b, MEMBER, KEEPER)).rejects.toThrow(
      'Only the keeper can hand over',
    );
    await handOver(git, a, KEEPER, MEMBER);
    expect((await readOrigin(a))?.keeper).toEqual({
      installId: MEMBER,
      name: 'Ann',
    });
    expect(await subject(a)).toBe(KEEPER_MESSAGE);
    expect(await keeperOf(a, MEMBER)).toEqual({
      installId: MEMBER,
      name: 'Ann',
      me: true,
      // Whom the keeper can hand over to: never themself.
      members: [{ installId: KEEPER, name: 'Dries' }],
    });
  });

  it("allows a take-over only after 14 days without the keeper's commits on the server", async () => {
    const at = '2026-11-01T12:00:00.000Z';
    await fs.writeFile(path.join(a, 'sources', 'n.md'), 'a note\n');
    await git.run(a, ['add', '-A']);
    await git.run(a, ['commit', '-q', '-m', 'Brain: add source n.md'], {
      env: { GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at },
    });
    await sync().push('a');
    // A member's own later commit does not count for the keeper.
    await fs.writeFile(path.join(b, 'sources', 'b.md'), 'from b\n');
    await git.run(b, ['add', '-A']);
    await git.run(b, ['commit', '-q', '-m', 'Brain: add source b.md']);
    await sync().pull('b');

    const t = Date.parse(at);
    await expect(
      takeOver(git, b, MEMBER, new Date(t + 13 * DAY)),
    ).rejects.toThrow("The keeper's Shellie sent changes in the last 14 days");
    expect((await readOrigin(b))?.keeper.installId).toBe(KEEPER);
    await takeOver(git, b, MEMBER, new Date(t + 15 * DAY));
    expect((await readOrigin(b))?.keeper).toEqual({
      installId: MEMBER,
      name: 'Ann',
    });
    expect(await subject(b)).toBe(KEEPER_MESSAGE);
  });

  it('counts the share commit when the keeper made no commit of its own', async () => {
    const t = Date.parse(SHARED_AT);
    await expect(
      takeOver(git, b, MEMBER, new Date(t + 13 * DAY)),
    ).rejects.toThrow("The keeper's Shellie sent changes in the last 14 days");
    await takeOver(git, b, MEMBER, new Date(t + 15 * DAY));
    expect((await readOrigin(b))?.keeper.installId).toBe(MEMBER);
  });

  it('refuses a take-over when the server cannot be reached, and changes nothing', async () => {
    await git.run(b, [
      'remote',
      'set-url',
      'origin',
      path.join(root, 'gone.git'),
    ]);
    const before = await fs.readFile(
      path.join(b, 'brain', 'origin.json'),
      'utf8',
    );
    await expect(
      takeOver(git, b, MEMBER, new Date(Date.parse(SHARED_AT) + 30 * DAY)),
    ).rejects.toThrow(UNREACHABLE);
    expect(
      await fs.readFile(path.join(b, 'brain', 'origin.json'), 'utf8'),
    ).toBe(before);
    expect(await subject(b)).not.toBe(KEEPER_MESSAGE);
  });

  it("refuses a take-over before the server's latest changes are merged", async () => {
    await fs.writeFile(path.join(a, 'sources', 'n.md'), 'a note\n');
    await git.run(a, ['add', '-A']);
    await git.run(a, ['commit', '-q', '-m', 'Brain: add source n.md']);
    await sync().push('a');
    await expect(
      takeOver(git, b, MEMBER, new Date(Date.now() + 30 * DAY)),
    ).rejects.toThrow("doesn't have the server's latest changes");
    expect((await readOrigin(b))?.keeper.installId).toBe(KEEPER);
  });
});
