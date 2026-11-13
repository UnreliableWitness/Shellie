import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainSchema } from '../../../shared/brain';
import { joinLink, type BrainHome } from '../../../shared/brainShare';
import { AdoError, CODE_READ_DENIED } from '../../services/AdoClient';
import { GitClient } from '../../services/GitClient';
import { BrainStore } from '../BrainStore';
import { scaffoldBrain } from '../scaffold';
import { readMembers, upsertMember, writeOrigin, writeShared } from './files';
import {
  discoverCustomerBrains,
  joinBrain,
  previewJoin,
  type DiscoverCache,
  type JoinDeps,
} from './join';

// real git, many subprocesses per test: slow under load and on the Windows runner
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const git = new GitClient();
const NOW = new Date('2026-11-13T12:00:00.000Z');
const CUSTOMER = 'https://dev.azure.com/customer';
const COMPANY = 'https://dev.azure.com/company';
const WIKI = {
  wikiId: 'w1',
  wikiName: 'Webshop.wiki',
  type: 'projectWiki' as const,
  repositoryId: 'wr1',
  mappedPath: '/',
  version: 'wikiMaster',
  gitUrl: 'https://dev.azure.com/customer/Webshop/_git/Webshop.wiki',
  rootPath: '/',
};

let root: string;
let server: string;
let userData: string;
let brains: BrainStore;
let home: BrainHome | null;
let saved: { organizationUrl: string; project: string; pat: string }[];
let calls: { org: string; token: string; what: string }[];
let originDenied: boolean;
let repoDenied: boolean;
let repoUrl: string;
let extraRepos: { id: string; name: string; origin: string | null }[];

const companyLink = joinLink({
  organizationUrl: COMPANY,
  project: 'Brains',
  repositoryId: 'repo-1',
});
const customerLink = joinLink({
  organizationUrl: CUSTOMER,
  project: 'Webshop',
  repositoryId: 'repo-1',
});

/** The keeper's machine: a brain shared to the server, with its share files. */
async function keeperShares(dir: string) {
  await scaffoldBrain(git, dir, 'Webshop brain');
  await writeOrigin(dir, {
    format: 1,
    organizationUrl: CUSTOMER,
    project: 'Webshop',
    name: 'Webshop brain',
    keeper: { installId: 'install-1', name: 'Dries' },
    sharedAt: '2026-11-13T10:00:00.000Z',
  });
  await upsertMember(dir, {
    installId: 'install-1',
    name: 'Dries',
    joinedAt: '2026-11-13T10:00:00.000Z',
  });
  await writeShared(
    dir,
    {
      wiki: WIKI,
      lastRefreshAt: '2026-11-12T09:00:00.000Z',
      lastDigestAt: '2026-11-10T09:00:00.000Z',
      templatesVersion: 7,
    },
    new Date('2026-11-13T10:00:00.000Z'),
  );
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-q', '-m', 'Brain: shared']);
  await git.run(dir, ['remote', 'add', 'origin', server]);
  await git.run(dir, ['push', '-q', 'origin', 'HEAD:main']);
}

const serverFile = (rel: string) =>
  git.run(root, ['--git-dir', server, 'show', `main:${rel}`]).catch(() => null);

function deps(over: Partial<JoinDeps> = {}): JoinDeps {
  return {
    brains,
    git,
    home: {
      get: () => home,
      save: async (input) => {
        saved.push(input);
        home = {
          organizationUrl: input.organizationUrl,
          project: input.project,
          user: 'Ann',
        };
        return home;
      },
      token: async () => 'home-token',
    },
    connections: {
      list: () => [
        {
          id: 'c1',
          organizationUrl: CUSTOMER,
          project: 'Webshop',
          user: 'Ann',
        },
      ],
      token: async (id) => `token-${id}`,
    },
    userData,
    installId: async () => 'install-2',
    ado: (org, token) => ({
      itemText: async (project, repositoryId, p) => {
        calls.push({ org, token: await token(), what: `item ${repositoryId}` });
        if (originDenied)
          throw new AdoError('unauthorized', p, CODE_READ_DENIED, 403);
        const extra = extraRepos.find((r) => r.id === repositoryId);
        if (extra) return p === '/brain/origin.json' ? extra.origin : null;
        return repositoryId === 'repo-1' ? serverFile(p.slice(1)) : null;
      },
      repositoryById: async (id) => {
        calls.push({ org, token: await token(), what: `repo ${id}` });
        if (repoDenied)
          throw new AdoError('unauthorized', 'x', CODE_READ_DENIED, 403);
        return {
          id,
          name: 'webshop-brain',
          remoteUrl: repoUrl,
          project: org === COMPANY ? 'Brains' : 'Webshop',
          defaultBranch: 'refs/heads/main',
        };
      },
      repositories: async (project) => {
        calls.push({ org, token: await token(), what: `repos ${project}` });
        return [
          {
            id: 'repo-1',
            name: 'webshop-brain',
            remoteUrl: repoUrl,
            defaultBranch: 'refs/heads/main',
          },
          ...extraRepos.map((r) => ({
            id: r.id,
            name: r.name,
            remoteUrl: `${repoUrl}-${r.id}`,
            defaultBranch: null,
          })),
        ];
      },
    }),
    now: () => NOW,
    ...over,
  };
}

const brainFolders = () =>
  fs.readdir(path.join(userData, 'brains')).catch(() => [] as string[]);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-join-'));
  server = path.join(root, 'server.git');
  repoUrl = server;
  userData = path.join(root, 'userData');
  await fs.mkdir(userData);
  await git.run(root, ['init', '-q', '--bare', '-b', 'main', server]);
  await keeperShares(path.join(root, 'keeper'));
  brains = new BrainStore(path.join(root, 'brains.json'));
  await brains.load();
  home = { organizationUrl: COMPANY, project: 'Brains', user: 'Ann' };
  saved = [];
  calls = [];
  originDenied = false;
  repoDenied = false;
  extraRepos = [];
});

afterEach(async () => {
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

describe('previewJoin', () => {
  it("gives the brain's name and customer project, read with the brain home's token", async () => {
    expect(await previewJoin(deps(), companyLink)).toEqual({
      name: 'Webshop brain',
      organizationUrl: CUSTOMER,
      project: 'Webshop',
      connectionId: 'c1',
      needsToken: false,
      alreadyHave: false,
    });
    expect(
      calls.every((c) => c.org === COMPANY && c.token === 'home-token'),
    ).toBe(true);
  });

  it('prefers a connection in the link organization over the brain home', async () => {
    await previewJoin(deps(), customerLink);
    expect(calls.map((c) => c.token)).toEqual(['token-c1', 'token-c1']);
  });

  it('has no connection id when the person has no connection for the customer project, and writes nothing', async () => {
    const d = deps({
      connections: {
        list: () => [
          {
            id: 'c2',
            organizationUrl: CUSTOMER,
            project: 'Intranet',
            user: 'Ann',
          },
        ],
        token: async (id) => `token-${id}`,
      },
    });
    const p = await previewJoin(d, companyLink);
    expect(p.connectionId).toBeNull();
    expect(p.name).toBe('Webshop brain');
    await expect(joinBrain(d, companyLink, {})).rejects.toThrow(
      'Add the Webshop project in Shellie first',
    );
    expect(brains.list()).toEqual([]);
    expect(await brainFolders()).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('asks for a token when no connection or brain home covers the organization', async () => {
    home = null;
    expect(await previewJoin(deps(), companyLink)).toMatchObject({
      needsToken: true,
      organizationUrl: COMPANY,
      connectionId: null,
    });
    expect(calls).toEqual([]);
  });

  it("gives Azure DevOps's words when the token cannot read the brain", async () => {
    originDenied = true;
    await expect(previewJoin(deps(), companyLink)).rejects.toThrow(
      CODE_READ_DENIED,
    );
  });

  it('names the keeper when access is refused once origin.json is known', async () => {
    repoDenied = true;
    const e = await previewJoin(deps(), companyLink).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AdoError);
    expect((e as AdoError).kind).toBe('unauthorized');
    expect((e as AdoError).message).toBe(
      "You don't have access to this brain; ask Dries",
    );
  });

  it('says so when the repo holds no shared brain', async () => {
    const link = joinLink({
      organizationUrl: COMPANY,
      project: 'Brains',
      repositoryId: 'nope',
    });
    await expect(previewJoin(deps(), link)).rejects.toThrow(
      'This repo holds no shared brain',
    );
  });

  it('refuses anything that is not a join link', async () => {
    await expect(previewJoin(deps(), 'https://example.com')).rejects.toThrow(
      'not a Shellie join link',
    );
  });

  it('makes no Azure DevOps call for a link to another host', async () => {
    const evil = joinLink({
      organizationUrl: 'https://evil.example/x',
      project: 'Brains',
      repositoryId: 'repo-1',
    });
    await expect(previewJoin(deps(), evil, { pat: 'typed' })).rejects.toThrow(
      'not a Shellie join link',
    );
    await expect(joinBrain(deps(), evil, { pat: 'typed' })).rejects.toThrow(
      'not a Shellie join link',
    );
    expect(calls).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('refuses a brain in another organization than the brain home, with nothing to reach it', async () => {
    const elsewhere = joinLink({
      organizationUrl: 'https://dev.azure.com/elsewhere',
      project: 'Brains',
      repositoryId: 'repo-1',
    });
    const message =
      'This brain is in https://dev.azure.com/elsewhere. Your brain home is https://dev.azure.com/company; Shellie has one brain home for now.';
    await expect(
      previewJoin(deps(), elsewhere, { pat: 'typed' }),
    ).rejects.toThrow(message);
    await expect(
      joinBrain(deps(), elsewhere, { pat: 'typed' }),
    ).rejects.toThrow(message);
    expect(calls).toEqual([]);
    expect(saved).toEqual([]);
    expect(brains.list()).toEqual([]);
    expect(await brainFolders()).toEqual([]);
  });

  it('knows when the person already has a brain for that connection and project', async () => {
    await brains.add(
      BrainSchema.parse({
        id: 'mine',
        name: 'Mine',
        connectionId: 'c1',
        project: 'Webshop',
        path: path.join(root, 'mine'),
        createdAt: '2026-11-01T09:00:00.000Z',
      }),
    );
    expect((await previewJoin(deps(), companyLink)).alreadyHave).toBe(true);
    await expect(joinBrain(deps(), companyLink, {})).rejects.toThrow(
      'You already have a brain for this project',
    );
    expect(brains.list()).toHaveLength(1);
    expect(await brainFolders()).toEqual([]);
  });
});

describe('joinBrain', () => {
  it("clones the brain and records it on the person's connection with the shared facts", async () => {
    const b = await joinBrain(deps(), companyLink, {});
    expect(path.dirname(b.path)).toBe(path.join(userData, 'brains'));
    expect(path.basename(b.path)).toBe(b.id);
    expect(brains.get(b.id)).toEqual(b);
    expect(b).toMatchObject({
      name: 'Webshop brain',
      connectionId: 'c1',
      project: 'Webshop',
      wiki: WIKI,
      lastRefreshAt: '2026-11-12T09:00:00.000Z',
      lastDigestAt: '2026-11-10T09:00:00.000Z',
      templatesVersion: 7,
      createdAt: NOW.toISOString(),
      sharing: {
        home: 'company',
        remoteUrl: server,
        repositoryId: 'repo-1',
        homeOrganizationUrl: COMPANY,
        homeProject: 'Brains',
        joinedAt: NOW.toISOString(),
        lastPullAt: null,
        lastPushAt: null,
        status: 'pending',
        heldFile: null,
      },
    });
    expect(b.options).toEqual(BrainSchema.parse({ ...b, options: {} }).options);
    const members = await readMembers(b.path);
    expect(members?.members.map((m) => [m.installId, m.name])).toEqual([
      ['install-1', 'Dries'],
      ['install-2', 'Ann'],
    ]);
    expect(
      (await git.run(b.path, ['log', '-1', '--format=%s|%ae|%an'])).trim(),
    ).toBe('Brain: joined|install-2@install.shellie|Ann');
    expect(
      (await git.run(b.path, ['config', '--local', 'user.email'])).trim(),
    ).toBe('install-2@install.shellie');
    expect((await git.run(b.path, ['status', '--porcelain'])).trim()).toBe('');
    // The sync pushes it; the join itself does not.
    expect(await serverFile('brain/members.json')).not.toContain('install-2');
  });

  it('marks a brain joined in the customer project as such', async () => {
    const b = await joinBrain(deps(), customerLink, {});
    expect(b.sharing).toMatchObject({
      home: 'customer',
      homeOrganizationUrl: CUSTOMER,
      homeProject: 'Webshop',
    });
  });

  it('leaves no folder and no record when the clone fails', async () => {
    repoUrl = path.join(root, 'gone.git');
    await expect(joinBrain(deps(), companyLink, {})).rejects.toThrow();
    expect(brains.list()).toEqual([]);
    expect(await brainFolders()).toEqual([]);
  });

  it('removes the clone and records nothing when a step after the clone fails', async () => {
    const d = deps({
      installId: async () => {
        throw new Error('disk full');
      },
    });
    await expect(joinBrain(d, companyLink, {})).rejects.toThrow('disk full');
    expect(brains.list()).toEqual([]);
    expect(await brainFolders()).toEqual([]);
  });

  it('signs the clone in with the token it found, never on the command line', async () => {
    repoUrl = 'https://dev.azure.com/company/Brains/_git/webshop-brain';
    const seen: { args: string[]; env?: Record<string, string> }[] = [];
    const spy = new GitClient();
    vi.spyOn(spy, 'run').mockImplementation(async (_cwd, args, opts) => {
      seen.push({ args, env: opts?.env });
      throw new Error('offline');
    });
    await expect(
      joinBrain(deps({ git: spy }), companyLink, {}),
    ).rejects.toThrow('offline');
    const clone = seen.find((s) => s.args.includes('clone'));
    expect(clone?.args.join(' ')).not.toContain('home-token');
    const header = Buffer.from(':home-token').toString('base64');
    expect(Object.values(clone?.env ?? {}).join(' ')).toContain(header);
    expect(await brainFolders()).toEqual([]);
  });

  it('saves a token typed at the link as the brain home when there is none', async () => {
    home = null;
    const d = deps({ connections: { list: () => [], token: async () => '' } });
    expect(
      (await previewJoin(d, companyLink, { pat: 'typed' })).needsToken,
    ).toBe(false);
    expect(calls.every((c) => c.token === 'typed')).toBe(true);
    // No connection for the customer project yet: nothing is saved.
    await expect(joinBrain(d, companyLink, { pat: 'typed' })).rejects.toThrow(
      'Add the Webshop project',
    );
    expect(saved).toEqual([]);
    const withConnection = deps({
      home: { ...d.home },
    });
    await joinBrain(withConnection, companyLink, { pat: 'typed' });
    expect(saved).toEqual([
      { organizationUrl: COMPANY, project: 'Brains', pat: 'typed' },
    ]);
  });

  it('never makes a customer organization the brain home', async () => {
    home = null;
    const b = await joinBrain(deps(), customerLink, { pat: 'typed' });
    expect(b.sharing?.home).toBe('customer');
    expect(saved).toEqual([]);
  });

  it('saves no brain home when the join fails after the clone', async () => {
    home = null;
    const d = deps({
      installId: async () => {
        throw new Error('disk full');
      },
    });
    await expect(joinBrain(d, companyLink, { pat: 'typed' })).rejects.toThrow(
      'disk full',
    );
    expect(saved).toEqual([]);
  });

  it('records nothing when the brain home cannot be saved', async () => {
    home = null;
    const d = deps();
    d.home.save = async () => {
      throw new Error('Token encryption is not available');
    };
    await expect(joinBrain(d, companyLink, { pat: 'typed' })).rejects.toThrow(
      'Token encryption is not available',
    );
    expect(brains.list()).toEqual([]);
    expect(await brainFolders()).toEqual([]);
  });

  it('keeps an existing brain home when a token is typed', async () => {
    await joinBrain(deps(), companyLink, { pat: 'typed' });
    expect(saved).toEqual([]);
  });
});

describe('discoverCustomerBrains', () => {
  it("lists the project's repos whose origin.json is that project's, once per session", async () => {
    const otherOrigin = JSON.stringify({
      format: 1,
      organizationUrl: CUSTOMER,
      project: 'Intranet',
      name: 'Intranet brain',
      keeper: { installId: 'x', name: 'Bo' },
      sharedAt: '2026-11-13T10:00:00.000Z',
    });
    extraRepos = [
      { id: 'repo-2', name: 'webshop', origin: null },
      { id: 'repo-3', name: 'intranet-brain', origin: otherOrigin },
      { id: 'repo-4', name: 'broken', origin: '{not json' },
    ];
    const cache: DiscoverCache = new Map();
    const want = [
      {
        repositoryId: 'repo-1',
        name: 'Webshop brain',
        joinLink: customerLink,
      },
    ];
    expect(await discoverCustomerBrains(deps(), 'c1', { cache })).toEqual(want);
    const listed = () => calls.filter((c) => c.what.startsWith('repos')).length;
    expect(listed()).toBe(1);
    expect(
      calls.every((c) => c.org === CUSTOMER && c.token === 'token-c1'),
    ).toBe(true);
    expect(await discoverCustomerBrains(deps(), 'c1', { cache })).toEqual(want);
    expect(listed()).toBe(1);
    await discoverCustomerBrains(deps(), 'c1', { cache, refresh: true });
    expect(listed()).toBe(2);
  });
});
