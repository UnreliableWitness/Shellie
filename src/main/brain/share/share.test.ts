import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainSchema, type BrainJob } from '../../../shared/brain';
import { GitClient, GitError } from '../../services/GitClient';
import { connectionIdForBrain } from '../../services/gitAuth';
import { BRAIN_HOME_CONNECTION_ID } from '../../../shared/brainShare';
import { BrainStore } from '../BrainStore';
import { commitJobOutput, OUTSIDE_EDIT_MESSAGE } from '../brainHandlers';
import { scaffoldBrain } from '../scaffold';
import { readState, writeState } from '../state';
import { BrainSync, PRE_SHARE_REF, type SyncRunner } from './BrainSync';
import { readMembers, readOrigin, readShared, upsertMember } from './files';
import { LEAVE_MESSAGE } from '../brainCommits';
import { leaveBrain, shareBrain, stopSharing, type ShareDeps } from './share';

// real git, many subprocesses per test: slow under load and on the Windows runner
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const git = new GitClient();
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const NOW = new Date('2026-11-13T10:00:00.000Z');
const INSTALL = 'install-1';

let root: string;
let server: string;
let dir: string;
let brains: BrainStore;
let enqueued: [string, string][];
let made: { org: string; token: string; project: string; name: string }[];
let remoteUrl: string;

const write = async (rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text);
};
const commit = async (message: string) => {
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-q', '-m', message]);
};
const head = async () => (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
const onServer = (args: string[]) =>
  git.run(root, ['--git-dir', server, ...args]);
const exists = (rel: string) =>
  fs.access(path.join(dir, rel)).then(
    () => true,
    () => false,
  );

function deps(over: Partial<ShareDeps> = {}): ShareDeps {
  const jobs: BrainJob[] = [];
  return {
    brains,
    git,
    home: {
      get: () => ({
        organizationUrl: 'https://dev.azure.com/company',
        project: 'Brains',
        user: 'Dries at home',
      }),
      token: async () => 'home-token',
    },
    connections: {
      get: () => ({
        organizationUrl: 'https://dev.azure.com/customer',
        user: 'Dries',
      }),
      token: async () => 'customer-token',
    },
    runner: {
      enqueue: (id, kind) => {
        enqueued.push([id, kind]);
        const job = { id: 'j1', brainId: id, kind, status: 'queued' };
        jobs.push(job as BrainJob);
        return job as BrainJob;
      },
      jobs: () => jobs,
      running: () => false,
    },
    installId: async () => INSTALL,
    ado: (org, token) => ({
      createRepository: async (project, name) => {
        made.push({ org, token: await token(), project, name });
        return { id: 'repo-1', remoteUrl };
      },
    }),
    now: () => NOW,
    ...over,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-share-'));
  server = path.join(root, 'server.git');
  remoteUrl = server;
  dir = path.join(root, 'brain');
  await git.run(root, ['init', '-q', '--bare', '-b', 'main', server]);
  await scaffoldBrain(git, dir, 'Acme');
  await write('wiki/x.md', '# X\n\nA page.\n');
  await commit('Brain: capture sources/a.md');
  brains = new BrainStore(path.join(root, 'brains.json'));
  await brains.load();
  await brains.add(
    BrainSchema.parse({
      id: 'a',
      name: 'Acme',
      connectionId: 'c',
      project: 'Webshop',
      path: dir,
      createdAt: '2026-11-01T09:00:00.000Z',
      templatesVersion: 7,
      lastRefreshAt: '2026-11-12T09:00:00.000Z',
      lastDigestAt: '2026-11-10T09:00:00.000Z',
    }),
  );
  enqueued = [];
  made = [];
});

afterEach(async () => {
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

describe('shareBrain', () => {
  it('pushes one fresh commit of the tree and the share files, without a source removed earlier', async () => {
    await write('sources/old.md', 'an old source, removed later\n');
    await commit('Brain: add source old.md');
    const oldBlob = (
      await git.run(dir, ['hash-object', 'sources/old.md'])
    ).trim();
    await git.run(dir, ['rm', '-q', 'sources/old.md']);
    await git.run(dir, ['commit', '-q', '-m', 'Brain: remove source old.md']);
    const synced = await head();
    await writeState(dir, (s) => ({ ...s, lastSyncCommit: synced }));
    await commit('Brain: sync');
    const before = await head();

    const r = await shareBrain(deps(), {
      brainId: 'a',
      home: 'company',
      repoName: 'Acme brain',
    });

    expect(r).toEqual({
      status: 'shared',
      joinLink:
        'shellie://join?org=https%3A%2F%2Fdev.azure.com%2Fcompany&project=Brains&repo=repo-1',
    });
    expect((await onServer(['rev-list', '--count', 'main'])).trim()).toBe('1');
    expect((await onServer(['log', '-1', '--format=%s', 'main'])).trim()).toBe(
      'Brain: shared',
    );
    const files = (
      await onServer(['ls-tree', '-r', '--name-only', 'main'])
    ).split('\n');
    expect(files).toEqual(
      expect.arrayContaining([
        'wiki/x.md',
        'SCHEMA.md',
        'brain/origin.json',
        'brain/members.json',
        'brain/shared.json',
        'brain/state.json',
      ]),
    );
    expect(files).not.toContain('sources/old.md');
    await expect(onServer(['cat-file', '-e', oldBlob])).rejects.toThrow();
    // The local brain is on that commit; its old history stays in a local ref.
    expect(await head()).toBe((await onServer(['rev-parse', 'main'])).trim());
    expect((await git.run(dir, ['rev-parse', PRE_SHARE_REF])).trim()).toBe(
      before,
    );
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
    // The commit carries this machine's identity.
    expect((await git.run(dir, ['log', '-1', '--format=%ae|%an'])).trim()).toBe(
      `${INSTALL}@install.shellie|Dries`,
    );
    expect((await readState(dir)).state?.lastSyncCommit).toBeNull();
    expect(await readOrigin(dir)).toEqual({
      format: 1,
      organizationUrl: 'https://dev.azure.com/customer',
      project: 'Webshop',
      name: 'Acme',
      keeper: { installId: INSTALL, name: 'Dries' },
      sharedAt: NOW.toISOString(),
    });
    expect((await readMembers(dir))?.members).toEqual([
      { installId: INSTALL, name: 'Dries', joinedAt: NOW.toISOString() },
    ]);
    expect(await readShared(dir)).toMatchObject({
      wiki: null,
      lastRefreshAt: '2026-11-12T09:00:00.000Z',
      lastDigestAt: '2026-11-10T09:00:00.000Z',
      templatesVersion: 7,
    });
    expect(brains.get('a')?.sharing).toEqual({
      home: 'company',
      remoteUrl: server,
      repositoryId: 'repo-1',
      homeOrganizationUrl: 'https://dev.azure.com/company',
      homeProject: 'Brains',
      joinedAt: NOW.toISOString(),
      lastPullAt: null,
      lastPushAt: NOW.toISOString(),
      status: 'ok',
      heldFile: null,
    });
    await expect(
      shareBrain(deps(), { brainId: 'a', home: 'company', repoName: 'x' }),
    ).rejects.toThrow('Already shared');
  });

  it("moves long reads' commits off the old history, so /write update never names an unknown commit", async () => {
    const old = await head();
    await write(
      'brain/reads.json',
      JSON.stringify({
        reads: { 'reads/r.md': { at: 'x', commit: old, pages: {} } },
        extra: 'kept',
      }),
    );
    await write('reads/r.md', 'A read\n');
    await writeState(dir, (s) => ({ ...s, lastSyncCommit: old }));
    await commit('Brain: sync');
    const r = await shareBrain(deps(), {
      brainId: 'a',
      home: 'company',
      repoName: 'Acme brain',
    });
    expect(r.status).toBe('shared');
    const onMain = JSON.parse(
      await onServer(['show', 'main:brain/reads.json']),
    ) as { reads: Record<string, { commit: string | null }>; extra: string };
    expect(onMain.reads['reads/r.md'].commit).toBeNull();
    expect(onMain.extra).toBe('kept');
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('creates the repo through the home for the company home and through the connection for the customer', async () => {
    await shareBrain(deps(), {
      brainId: 'a',
      home: 'company',
      repoName: 'Acme brain',
    });
    expect(made).toEqual([
      {
        org: 'https://dev.azure.com/company',
        token: 'home-token',
        project: 'Brains',
        name: 'Acme brain',
      },
    ]);
    await stopSharing(deps(), 'a');
    // A second share goes to a new, empty repo.
    remoteUrl = path.join(root, 'server2.git');
    await git.run(root, ['init', '-q', '--bare', '-b', 'main', remoteUrl]);
    made = [];
    const r = await shareBrain(deps(), {
      brainId: 'a',
      home: 'customer',
      repoName: 'Acme brain',
    });
    expect(made).toEqual([
      {
        org: 'https://dev.azure.com/customer',
        token: 'customer-token',
        project: 'Webshop',
        name: 'Acme brain',
      },
    ]);
    expect(r).toMatchObject({
      joinLink:
        'shellie://join?org=https%3A%2F%2Fdev.azure.com%2Fcustomer&project=Webshop&repo=repo-1',
    });
    expect(brains.get('a')?.sharing).toMatchObject({
      home: 'customer',
      homeOrganizationUrl: 'https://dev.azure.com/customer',
      homeProject: 'Webshop',
    });
  });

  it('pushes with the sign-in of the home the repo was made in', async () => {
    const seen: (string | null)[] = [];
    const signedIn = new GitClient(undefined, {
      auth: async ({ cwd }) => {
        seen.push(connectionIdForBrain(brains.list(), cwd));
        return { env: {}, connectionId: null };
      },
    });
    await shareBrain(deps({ git: signedIn }), {
      brainId: 'a',
      home: 'company',
      repoName: 'Acme brain',
    });
    expect(seen).toEqual([BRAIN_HOME_CONNECTION_ID]);
    await stopSharing(deps(), 'a');
    remoteUrl = path.join(root, 'server2.git');
    await git.run(root, ['init', '-q', '--bare', '-b', 'main', remoteUrl]);
    seen.length = 0;
    await shareBrain(deps({ git: signedIn }), {
      brainId: 'a',
      home: 'customer',
      repoName: 'Acme brain',
    });
    expect(seen).toEqual(['c']);
  });

  it('runs a sync first when a capture came after the last sync', async () => {
    const synced = await head();
    await writeState(dir, (s) => ({ ...s, lastSyncCommit: synced }));
    await commit('Brain: sync');
    const d = deps();
    // Only the sync's own commit since: nothing to sync.
    remoteUrl = path.join(root, 'nowhere.git');
    await expect(
      shareBrain(d, { brainId: 'a', home: 'company', repoName: 'x' }),
    ).rejects.toThrow(/can be deleted/);
    expect(enqueued).toEqual([]);
    await write('wiki/y.md', '# Y\n\nCaptured.\n');
    await commit('Brain: capture sources/b.md');
    expect(
      await shareBrain(d, { brainId: 'a', home: 'company', repoName: 'x' }),
    ).toEqual({ status: 'syncing' });
    expect(enqueued).toEqual([['a', 'sync']]);
  });

  it('runs a sync first when there are captures and never a sync', async () => {
    await writeState(dir, (s) => ({
      ...s,
      captured: {
        'sources/a.md': { at: '2026-11-12T09:00:00.000Z', sessionId: null },
      },
    }));
    await commit('Brain: capture sources/a.md');
    expect(
      await shareBrain(deps(), {
        brainId: 'a',
        home: 'company',
        repoName: 'x',
      }),
    ).toEqual({ status: 'syncing' });
    expect(made).toEqual([]);
  });

  it('scans a file as committed, not as it is on disk', async () => {
    await write('sources/big.md', `${'filler line\n'.repeat(200)}${TOKEN}\n`);
    await commit('Brain: add source big.md');
    await write('sources/big.md', 'cleaned on disk only\n');
    expect(
      await shareBrain(deps(), {
        brainId: 'a',
        home: 'company',
        repoName: 'x',
      }),
    ).toEqual({ status: 'secrets', files: ['sources/big.md'] });
    expect(made).toEqual([]);
  });

  it('checks a commit made while the repo was being created', async () => {
    let added = '';
    const d = deps({
      ado: () => ({
        createRepository: async () => {
          // A source added meanwhile (addSource takes no brain lock).
          await write('sources/late.md', `key ${TOKEN}\n`);
          await commit('Brain: add source late.md');
          added = await head();
          return { id: 'repo-1', remoteUrl };
        },
      }),
    });
    await expect(
      shareBrain(d, { brainId: 'a', home: 'company', repoName: 'Acme brain' }),
    ).rejects.toThrow(/changed while it was being shared.*can be deleted/);
    expect(await head()).toBe(added);
    expect(brains.get('a')?.sharing).toBeNull();
    expect(
      await onServer(['rev-parse', '--verify', '-q', 'main']).catch(
        () => 'none',
      ),
    ).toBe('none');
  });

  it('stops at a possible secret in a wiki page, with no repo made', async () => {
    await write('wiki/key.md', `# Key\n\nThe token is ${TOKEN}\n`);
    await commit('Brain: capture sources/b.md');
    const before = await head();
    const r = await shareBrain(deps(), {
      brainId: 'a',
      home: 'company',
      repoName: 'Acme brain',
    });
    expect(r).toEqual({ status: 'secrets', files: ['wiki/key.md'] });
    expect(made).toEqual([]);
    expect(await head()).toBe(before);
    expect(brains.get('a')?.sharing).toBeNull();
  });

  it('runs a sync first when there are outside edits', async () => {
    await write('wiki/x.md', '# X\n\nEdited by hand.\n');
    await commit(OUTSIDE_EDIT_MESSAGE);
    const d = deps();
    const r = await shareBrain(d, {
      brainId: 'a',
      home: 'company',
      repoName: 'Acme brain',
    });
    expect(r).toEqual({ status: 'syncing' });
    expect(enqueued).toEqual([['a', 'sync']]);
    expect(made).toEqual([]);
    // Asked again while that sync waits: no second one.
    await shareBrain(d, { brainId: 'a', home: 'company', repoName: 'x' });
    expect(enqueued).toHaveLength(1);
  });

  it('leaves the brain local and unchanged when the push fails', async () => {
    remoteUrl = path.join(root, 'nowhere.git');
    const before = await head();
    await expect(
      shareBrain(deps(), {
        brainId: 'a',
        home: 'company',
        repoName: 'Acme brain',
      }),
    ).rejects.toThrow(/can be deleted in Azure DevOps/);
    expect(await head()).toBe(before);
    expect(brains.get('a')?.sharing).toBeNull();
    expect(await git.remotes(dir)).toEqual([]);
    expect(await exists('brain/origin.json')).toBe(false);
    expect(await exists('brain/members.json')).toBe(false);
    expect(await exists('brain/shared.json')).toBe(false);
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
    await expect(
      git.run(dir, ['rev-parse', '--verify', '-q', PRE_SHARE_REF]),
    ).rejects.toThrow();
    expect((await git.run(dir, ['config', 'user.email'])).trim()).toBe(
      'shellie@localhost',
    );
  });
});

describe('stopSharing', () => {
  it('removes the remote and the sharing, and keeps origin.json', async () => {
    await shareBrain(deps(), {
      brainId: 'a',
      home: 'company',
      repoName: 'Acme brain',
    });
    await stopSharing(deps(), 'a');
    expect(brains.get('a')?.sharing).toBeNull();
    expect(await git.remotes(dir)).toEqual([]);
    expect(await exists('brain/origin.json')).toBe(true);
  });
});

describe('leaveBrain', () => {
  const syncFor = () =>
    new BrainSync({
      brains,
      git,
      runner: () => ({
        enqueue: vi.fn(),
        jobs: () => [],
        running: () => false,
        fail: () => false,
        release: () => undefined,
      }),
      changed: () => undefined,
      commitOutsideEdits: (id) =>
        commitJobOutput(git, brains.get(id)?.path ?? '', OUTSIDE_EDIT_MESSAGE),
    });
  const shareWithMember = async () => {
    await shareBrain(deps(), {
      brainId: 'a',
      home: 'company',
      repoName: 'Acme brain',
    });
    await upsertMember(dir, {
      installId: 'member-2',
      name: 'Anna',
      joinedAt: NOW.toISOString(),
    });
    await commit('Brain: joined');
    await git.push(dir, 'origin', 'HEAD:main');
  };
  const serverMembers = async () =>
    (
      JSON.parse(await onServer(['show', 'main:brain/members.json'])) as {
        members: { installId: string }[];
      }
    ).members.map((m) => m.installId);

  it("takes the member's line out on the server, then makes the brain local", async () => {
    await shareWithMember();
    expect(await serverMembers()).toEqual([INSTALL, 'member-2']);
    await leaveBrain(
      { brains, git, sync: syncFor(), installId: async () => 'member-2' },
      'a',
    );
    expect(await serverMembers()).toEqual([INSTALL]);
    expect((await onServer(['log', '-1', '--format=%s', 'main'])).trim()).toBe(
      LEAVE_MESSAGE,
    );
    expect(brains.get('a')?.sharing).toBeNull();
    expect(await git.remotes(dir)).toEqual([]);
  });

  it('still leaves when the server is out of reach', async () => {
    await shareWithMember();
    await git.run(dir, [
      'remote',
      'set-url',
      'origin',
      path.join(root, 'gone.git'),
    ]);
    await leaveBrain(
      { brains, git, sync: syncFor(), installId: async () => 'member-2' },
      'a',
    );
    expect(brains.get('a')?.sharing).toBeNull();
  });

  it('refuses the keeper: they hand over or stop sharing', async () => {
    await shareWithMember();
    await expect(
      leaveBrain(
        { brains, git, sync: syncFor(), installId: async () => INSTALL },
        'a',
      ),
    ).rejects.toThrow('You keep this brain: hand over first, or stop sharing');
    expect(brains.get('a')?.sharing).not.toBeNull();
  });
});

describe('the old history', () => {
  it('is dropped after the first successful pull', async () => {
    await shareBrain(deps(), {
      brainId: 'a',
      home: 'company',
      repoName: 'Acme brain',
    });
    const runner: SyncRunner = {
      enqueue: vi.fn(),
      jobs: () => [],
      running: () => false,
      fail: () => false,
      release: () => undefined,
    };
    const sync = new BrainSync({
      brains,
      git,
      runner: () => runner,
      changed: () => undefined,
      commitOutsideEdits: (id) =>
        commitJobOutput(git, brains.get(id)?.path ?? '', OUTSIDE_EDIT_MESSAGE),
    });
    await sync.pull('a');
    await expect(
      git.run(dir, ['rev-parse', '--verify', '-q', PRE_SHARE_REF]),
    ).rejects.toThrow();
    expect(brains.get('a')?.sharing?.lastPullAt).not.toBeNull();
  });
});

describe("shareBrain to a repo of the person's own", () => {
  const local = (url: string) =>
    url.startsWith('nope')
      ? null
      : { remoteUrl: url, host: 'github.com', owner: 'acme', name: 'brain' };
  const synced = async () => {
    const at = await head();
    await writeState(dir, (s) => ({ ...s, lastSyncCommit: at }));
    await commit('Brain: sync');
  };

  it('pushes the brain to the empty repo, makes no Azure DevOps repo, and gives a link with the address', async () => {
    await synced();
    const r = await shareBrain(deps({ parseRepo: local }), {
      brainId: 'a',
      home: 'repo',
      repoName: '',
      repoUrl: server,
    });
    expect(r).toEqual({
      status: 'shared',
      joinLink: `shellie://join?url=${encodeURIComponent(server)}`,
    });
    expect(made).toEqual([]);
    expect((await onServer(['log', '-1', '--format=%s', 'main'])).trim()).toBe(
      'Brain: shared',
    );
    expect(brains.get('a')?.sharing).toMatchObject({
      home: 'repo',
      remoteUrl: server,
      repositoryId: '',
      homeOrganizationUrl: 'https://github.com/acme',
      homeProject: 'brain',
      status: 'ok',
    });
    // Git signs in by itself there: the brain's own connection is named, never the brain home.
    expect(connectionIdForBrain(brains.list(), dir)).toBe('c');
  });

  it('refuses a repo that already has commits, and leaves the brain local', async () => {
    await synced();
    const other = path.join(root, 'other');
    await git.run(root, ['clone', '-q', server, other]);
    await fs.writeFile(path.join(other, 'README.md'), '# hi\n');
    await git.run(other, ['add', '-A']);
    await git.run(other, [
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@x',
      'commit',
      '-q',
      '-m',
      'readme',
    ]);
    await git.run(other, ['push', '-q', 'origin', 'HEAD:main']);
    const before = await head();
    await expect(
      shareBrain(deps({ parseRepo: local }), {
        brainId: 'a',
        home: 'repo',
        repoName: '',
        repoUrl: server,
      }),
    ).rejects.toThrow(/already has commits/);
    expect(await head()).toBe(before);
    expect(brains.get('a')?.sharing).toBeNull();
    expect(await git.remotes(dir)).toEqual([]);
  });

  it('refuses an address that is not a repo, an Azure DevOps one, and a repo git cannot reach', async () => {
    await synced();
    const share = (repoUrl: string, d = deps({ parseRepo: local })) =>
      shareBrain(d, { brainId: 'a', home: 'repo', repoName: '', repoUrl });
    await expect(share('nope')).rejects.toThrow(/Enter the repo's address/);
    await expect(
      share('https://dev.azure.com/customer/Webshop/_git/brain', deps()),
    ).rejects.toThrow(/choose the customer project/);
    await expect(share(path.join(root, 'nowhere.git'))).rejects.toThrow(
      /can't open acme\/brain on github.com/,
    );
    expect(brains.get('a')?.sharing).toBeNull();
  });
});

describe('the sign-in of a repo home', () => {
  const https = 'https://github.com/acme/brain';
  /** The address is GitHub's; git is sent to the local server, which opens only with the right token. */
  function gated(token: string) {
    const real = new GitClient();
    const g = Object.create(real) as GitClient;
    const tokenOf = (env: Record<string, string> = {}) => {
      const h = Object.values(env).find((v) => v.startsWith('Authorization: '));
      return h
        ? Buffer.from(h.split(' ').pop() ?? '', 'base64')
            .toString()
            .replace('x-access-token:', '')
        : null;
    };
    g.run = (cwd, args, opts = {}) => {
      if (args[0] === 'ls-remote' && tokenOf(opts.env) !== token)
        return Promise.reject(
          new GitError(args, 'remote: Repository not found.', 128),
        );
      return real.run(
        cwd,
        args.map((a) => (a === https ? server : a)),
        opts,
      );
    };
    return g;
  }
  const signIn = (accounts: string[]) => {
    const kept = new Map<string, string>();
    return {
      kept,
      deps: {
        gh: {
          accounts: async () => accounts,
          token: async (_h: string, user: string) => `token-of-${user}`,
        },
        tokens: {
          get: async (id: string) => kept.get(id) ?? null,
          set: async (id: string, t: string) => void kept.set(id, t),
          delete: async (id: string) => void kept.delete(id),
        },
      },
    };
  };
  const input = {
    brainId: 'a',
    home: 'repo',
    repoName: '',
    repoUrl: https,
  } as const;
  const synced = async () => {
    const at = await head();
    await writeState(dir, (s) => ({ ...s, lastSyncCommit: at }));
    await commit('Brain: sync');
  };

  it('shares as the GitHub CLI account that can open the repo, and records it', async () => {
    await synced();
    const s = signIn(['personal', 'work']);
    const r = await shareBrain(
      deps({ git: gated('token-of-work'), signIn: s.deps }),
      input,
    );
    expect(r.status).toBe('shared');
    expect(brains.get('a')?.sharing).toMatchObject({
      home: 'repo',
      signIn: { kind: 'gh', user: 'work' },
    });
    expect(s.kept.size).toBe(0);
  });

  it('asks for a token before any sync when nothing opens the repo, then keeps the typed one for the brain', async () => {
    // A sync is due, yet none is queued: the repo comes first.
    const s = signIn([]);
    const d = deps({ git: gated('typed'), signIn: s.deps });
    expect(await shareBrain(d, input)).toEqual({
      status: 'needsToken',
      host: 'github.com',
      tried: [
        'git as it is signed in on this machine',
        'the GitHub CLI (no account for github.com found)',
      ],
    });
    expect(enqueued).toEqual([]);
    await expect(
      shareBrain(d, { ...input, repoToken: 'wrong' }),
    ).rejects.toThrow(/That token can't open/);
    await synced();
    const r = await shareBrain(d, { ...input, repoToken: ' typed ' });
    expect(r.status).toBe('shared');
    expect(brains.get('a')?.sharing?.signIn).toEqual({ kind: 'token' });
    expect(s.kept.get('a')).toBe('typed');
    await stopSharing({ brains, git, signIn: s.deps }, 'a');
    expect(s.kept.size).toBe(0);
  });
});

describe('the sync before a share', () => {
  it('is not asked for again after a /sync that ended well, even when it recorded nothing', async () => {
    // Captures and no lastSyncCommit: a sync is due.
    await writeState(dir, (s) => ({
      ...s,
      captured: {
        'sources/a.md': { at: '2026-11-12T09:00:00.000Z', sessionId: null },
      },
    }));
    await commit('Brain: capture sources/a.md');
    const d = deps();
    const input = { brainId: 'a', home: 'company', repoName: 'x' } as const;
    expect(await shareBrain(d, input)).toEqual({ status: 'syncing' });
    // The /sync ran and ended well, but wrote no lastSyncCommit and made no commit.
    const job = d.runner.jobs('a')[0];
    job.status = 'done';
    job.endedAt = new Date(Date.now() + 1000).toISOString();
    expect((await shareBrain(d, input)).status).toBe('shared');
    expect(enqueued).toEqual([['a', 'sync']]);
  });

  it('is asked for again when the wiki changed after that /sync', async () => {
    const d = deps();
    d.runner.enqueue('a', 'sync');
    enqueued = [];
    const job = d.runner.jobs('a')[0];
    job.status = 'done';
    job.endedAt = new Date(Date.now() - 60_000).toISOString();
    await write('wiki/x.md', '# X\n\nEdited by hand, not committed.\n');
    expect(
      await shareBrain(d, { brainId: 'a', home: 'company', repoName: 'x' }),
    ).toEqual({ status: 'syncing' });
  });
});
