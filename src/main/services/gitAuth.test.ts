import { describe, expect, it } from 'vitest';
import type { Repo, Task } from '../../shared/types';
import {
  azureHeaderScope,
  connectionIdForBrain,
  connectionIdForPath,
  createGitAuth,
  extraHeaderEnv,
} from './gitAuth';
import { TokenUnavailableError } from './ConnectionStore';
import { BRAIN_HOME_CONNECTION_ID } from '../brain/share/BrainHomeStore';

const PAT = 'pat-secret-123';
const B64 = Buffer.from(`:${PAT}`).toString('base64');
const ADO = 'https://LocinoxBE@dev.azure.com/LocinoxBE/DXP/_git/DXP';

const conn = (id: string, organizationUrl: string, project = 'DXP') => ({
  id,
  organizationUrl,
  project,
});

describe('azureHeaderScope', () => {
  it('scopes dev.azure.com to the organization as the remote spells it', () => {
    expect(azureHeaderScope(ADO)).toBe('https://dev.azure.com/LocinoxBE/');
  });

  it('scopes visualstudio.com to the host', () => {
    expect(
      azureHeaderScope(
        'https://contoso.visualstudio.com/DefaultCollection/P/_git/R',
      ),
    ).toBe('https://contoso.visualstudio.com/');
  });

  it('leaves ssh, http and other hosts alone', () => {
    expect(azureHeaderScope('git@ssh.dev.azure.com:v3/org/p/r')).toBeNull();
    expect(azureHeaderScope('https://github.com/me/repo.git')).toBeNull();
    expect(azureHeaderScope('http://dev.azure.com/org/p/_git/r')).toBeNull();
    expect(azureHeaderScope('/local/origin.git')).toBeNull();
  });
});

describe('extraHeaderEnv', () => {
  it('adds one header entry with base64 of ":" + pat', () => {
    expect(extraHeaderEnv('https://dev.azure.com/org/', PAT, {})).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://dev.azure.com/org/.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${B64}`,
    });
  });

  it('appends after a GIT_CONFIG_COUNT already in the environment', () => {
    const env = extraHeaderEnv('https://dev.azure.com/org/', PAT, {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: '1',
      GIT_CONFIG_KEY_1: 'c.d',
      GIT_CONFIG_VALUE_1: '2',
    });
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: 'http.https://dev.azure.com/org/.extraHeader',
      GIT_CONFIG_VALUE_2: `Authorization: Basic ${B64}`,
    });
  });
});

describe('createGitAuth', () => {
  const make = (
    o: {
      connections?: ReturnType<typeof conn>[];
      own?: string | null;
      token?: (id: string) => Promise<string>;
    } = {},
  ) => {
    const asked: string[] = [];
    const auth = createGitAuth({
      connections: () =>
        o.connections ?? [conn('c1', 'https://dev.azure.com/locinoxbe')],
      token:
        o.token ??
        (async (id) => {
          asked.push(id);
          return PAT;
        }),
      connectionIdFor: () => o.own ?? null,
      base: {},
    });
    return { auth, asked };
  };

  it('uses the token of a connection in the remote organization', async () => {
    const { auth } = make();
    const r = await auth({ cwd: '/r', remote: 'origin', url: ADO });
    expect(r.connectionId).toBe('c1');
    expect(r.env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://dev.azure.com/LocinoxBE/.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${B64}`,
    });
  });

  it("prefers the repo's own connection when it is in that organization", async () => {
    const { auth, asked } = make({
      connections: [
        conn('c1', 'https://dev.azure.com/LocinoxBE'),
        conn('c2', 'https://dev.azure.com/LocinoxBE', 'Other'),
        conn('c3', 'https://dev.azure.com/elsewhere'),
      ],
      own: 'c2',
    });
    expect(
      (await auth({ cwd: '/r', remote: 'origin', url: ADO })).connectionId,
    ).toBe('c2');
    expect(asked).toEqual(['c2']);
  });

  it("ignores the repo's own connection when it is in another organization", async () => {
    const { auth } = make({
      connections: [
        conn('c3', 'https://dev.azure.com/elsewhere'),
        conn('c1', 'https://dev.azure.com/LocinoxBE', 'Other'),
      ],
      own: 'c3',
    });
    expect(
      (await auth({ cwd: '/r', remote: 'origin', url: ADO })).connectionId,
    ).toBe('c1');
  });

  it('works for visualstudio.com remotes', async () => {
    const { auth } = make({
      connections: [conn('c1', 'https://contoso.visualstudio.com', 'P')],
    });
    const r = await auth({
      cwd: '/r',
      remote: 'origin',
      url: 'https://contoso.visualstudio.com/P/_git/R',
    });
    expect(r.env.GIT_CONFIG_KEY_0).toBe(
      'http.https://contoso.visualstudio.com/.extraHeader',
    );
  });

  it('gives no environment without a matching connection, for ssh and for other hosts', async () => {
    const { auth, asked } = make({
      connections: [conn('c3', 'https://dev.azure.com/elsewhere')],
    });
    expect(await auth({ cwd: '/r', remote: 'origin', url: ADO })).toEqual({
      env: {},
      connectionId: null,
    });
    const any = make();
    for (const url of [
      'git@ssh.dev.azure.com:v3/LocinoxBE/DXP/DXP',
      'https://github.com/me/repo.git',
    ])
      expect(await any.auth({ cwd: '/r', remote: 'origin', url })).toEqual({
        env: {},
        connectionId: null,
      });
    expect([...asked, ...any.asked]).toEqual([]);
  });

  it('runs as before, naming the connection, when its token cannot be read', async () => {
    const { auth } = make({
      token: async () => {
        throw new TokenUnavailableError('Stored token could not be decrypted');
      },
    });
    expect(await auth({ cwd: '/r', remote: 'origin', url: ADO })).toEqual({
      env: {},
      connectionId: 'c1',
    });
  });
});

describe('connectionIdForPath', () => {
  const repo = { id: 'r1', path: '/src/app', connectionId: 'c1' } as Repo;
  const other = { id: 'r2', path: '/src/lib', connectionId: 'c2' } as Repo;
  const task = {
    repoId: 'r1',
    worktreePath: '/src/app.worktrees/t1',
    extraWorkspaces: [
      { id: 'w2', repoId: 'r2', worktreePath: '/src/lib.worktrees/t1' },
    ],
  } as unknown as Task;
  const state = { repos: [repo, other], tasks: [task] };

  it("finds the repo's connection from its main checkout or a task worktree", () => {
    expect(connectionIdForPath(state, '/src/app')).toBe('c1');
    expect(connectionIdForPath(state, '/src/app.worktrees/t1')).toBe('c1');
    expect(connectionIdForPath(state, '/src/lib.worktrees/t1')).toBe('c2');
    expect(connectionIdForPath(state, '/elsewhere')).toBeNull();
  });
});

describe('brain home sign-in', () => {
  const sharing = (home: 'customer' | 'company') =>
    ({ home }) as NonNullable<
      Parameters<typeof connectionIdForBrain>[0][number]['sharing']
    >;
  const brain = (
    p: string,
    home: 'customer' | 'company' | null,
  ): Parameters<typeof connectionIdForBrain>[0][number] => ({
    path: p,
    connectionId: 'c1',
    sharing: home ? sharing(home) : null,
  });

  it('names the home for a company brain and the brain connection otherwise', () => {
    const brains = [
      brain('/b/company', 'company'),
      brain('/b/customer', 'customer'),
      brain('/b/plain', null),
    ];
    expect(connectionIdForBrain(brains, '/b/company')).toBe(
      BRAIN_HOME_CONNECTION_ID,
    );
    expect(connectionIdForBrain(brains, '/b/customer')).toBe('c1');
    expect(connectionIdForBrain(brains, '/b/plain')).toBe('c1');
    expect(connectionIdForBrain(brains, '/elsewhere')).toBeNull();
  });

  it('a company brain uses the home token even with a customer connection in the same organization', async () => {
    const brains = [brain('/b/company', 'company')];
    const auth = createGitAuth({
      connections: () => [
        conn('c1', 'https://dev.azure.com/acme'),
        conn(BRAIN_HOME_CONNECTION_ID, 'https://dev.azure.com/acme', 'Brains'),
      ],
      token: async (id) => (id === BRAIN_HOME_CONNECTION_ID ? 'home-pat' : PAT),
      connectionIdFor: (cwd) => connectionIdForBrain(brains, cwd),
      base: {},
    });
    const r = await auth({
      cwd: '/b/company',
      remote: 'origin',
      url: 'https://dev.azure.com/acme/Brains/_git/brain',
    });
    expect(r.connectionId).toBe(BRAIN_HOME_CONNECTION_ID);
    expect(r.env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from(':home-pat').toString('base64')}`,
    );
  });
});
