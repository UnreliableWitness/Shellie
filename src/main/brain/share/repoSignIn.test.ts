import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRepoUrl } from '../../../shared/brainShare';
import { GitError, type GitClient } from '../../services/GitClient';
import {
  findSignIn,
  ghCli,
  repoBrainEnv,
  RepoTokenStore,
  tokenEnv,
  type RepoSignInDeps,
} from './repoSignIn';

const repo = parseRepoUrl('https://github.com/acme/brain.git')!;
const header = (user: string, token: string) =>
  `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
/** The header among git's environment, whatever its number (the machine may set GIT_CONFIG_* of its own). */
const headerOf = (env: Record<string, string> | null | undefined) =>
  Object.values(env ?? {}).find((v) => v.startsWith('Authorization: ')) ?? null;
const NOT_FOUND =
  "remote: Repository not found.\nfatal: repository 'x' not found";

/** A git whose server opens only for the given tokens (`null`: for git as it is on the machine). */
function gitFor(open: (string | null)[], failure = NOT_FOUND) {
  const seen: (string | null)[] = [];
  const git = {
    fetchTimeoutMs: 1000,
    run: async (
      _cwd: string,
      args: string[],
      opts: { env?: Record<string, string> } = {},
    ) => {
      const value = headerOf(opts.env);
      const token =
        value === null
          ? null
          : Buffer.from(value.split(' ').pop() ?? '', 'base64')
              .toString()
              .replace(/^x-access-token:/, '');
      seen.push(token);
      if (!open.includes(token)) throw new GitError(args, failure, 128);
      return 'abc\trefs/heads/main\n';
    },
  } as unknown as GitClient;
  return { git, seen };
}

function deps(over: Partial<RepoSignInDeps['gh']> = {}): RepoSignInDeps {
  const kept = new Map<string, string>();
  return {
    gh: {
      accounts: async () => ['personal', 'work'],
      token: async (_host, user) => `token-of-${user}`,
      ...over,
    },
    tokens: {
      get: async (id) => kept.get(id) ?? null,
      set: async (id, t) => void kept.set(id, t),
      delete: async (id) => void kept.delete(id),
    },
  };
}

describe('tokenEnv', () => {
  it('scopes the header to the owner on that host, and gives nothing for ssh', () => {
    const env = tokenEnv(repo, 'T');
    expect(Object.values(env)).toContain(
      'http.https://github.com/acme/.extraHeader',
    );
    expect(headerOf(env)).toBe(header('x-access-token', 'T'));
    expect(
      tokenEnv(parseRepoUrl('git@github.com:acme/brain.git')!, 'T'),
    ).toEqual({});
  });
});

describe('findSignIn', () => {
  it('uses git as it is on the machine when that opens the repo', async () => {
    const { git, seen } = gitFor([null]);
    expect(await findSignIn(deps(), git, '/', repo)).toEqual({
      signIn: null,
      env: {},
      heads: 'abc\trefs/heads/main\n',
    });
    expect(seen).toEqual([null]);
  });

  it('finds the GitHub CLI account that can open a repo the machine login cannot', async () => {
    const { git, seen } = gitFor(['token-of-work']);
    const found = await findSignIn(deps(), git, '/', repo);
    expect(found).toMatchObject({ signIn: { kind: 'gh', user: 'work' } });
    expect(seen).toEqual([null, 'token-of-personal', 'token-of-work']);
  });

  it('asks for a token when nothing opens an https repo, also without the GitHub CLI', async () => {
    expect(await findSignIn(deps(), gitFor([]).git, '/', repo)).toBe(
      'needsToken',
    );
    expect(
      await findSignIn(
        deps({ accounts: async () => Promise.reject(new Error('no gh')) }),
        gitFor([]).git,
        '/',
        repo,
      ),
    ).toBe('needsToken');
  });

  it('takes a typed token alone, and says so when it does not open the repo', async () => {
    const { git, seen } = gitFor(['typed']);
    expect(await findSignIn(deps(), git, '/', repo, ' typed ')).toMatchObject({
      signIn: { kind: 'token' },
    });
    expect(seen).toEqual(['typed']);
    await expect(findSignIn(deps(), git, '/', repo, 'wrong')).rejects.toThrow(
      /That token can't open acme\/brain on github.com/,
    );
  });

  it('throws at once for a failure that is not about access, an ssh repo, and without sign-in deps', async () => {
    const offline = gitFor(
      [],
      'fatal: unable to access: Could not resolve host',
    );
    await expect(findSignIn(deps(), offline.git, '/', repo)).rejects.toThrow(
      /Can't reach acme\/brain on github.com/,
    );
    expect(offline.seen).toEqual([null]);
    const ssh = parseRepoUrl('git@github.com:acme/brain.git')!;
    await expect(
      findSignIn(
        deps(),
        gitFor([], 'Permission denied (publickey).').git,
        '/',
        ssh,
      ),
    ).rejects.toThrow(/can't open acme\/brain/);
    await expect(
      findSignIn(undefined, gitFor([]).git, '/', repo),
    ).rejects.toThrow(/can't open acme\/brain/);
  });
});

describe('ghCli', () => {
  const platform = {
    probeCommand: (name: string) => ({ command: 'probe', args: [name] }),
  };

  it('lists the accounts of a host, the active one first, and asks a token once in ten minutes', async () => {
    const calls: string[][] = [];
    let at = 0;
    const gh = ghCli(
      platform,
      async (cmd) => {
        calls.push([cmd.command, ...cmd.args]);
        if (cmd.command === 'probe')
          return {
            code: 0,
            stdout: '/opt/homebrew/bin/gh\ngh version 2.94.0\n',
          };
        if (cmd.args[1] === 'status')
          return {
            // Non-zero: one account's token went bad; the list is still there.
            code: 1,
            stdout: JSON.stringify({
              hosts: {
                'github.com': [
                  { login: 'personal', active: false },
                  { login: 'work', active: true },
                ],
                'ghe.example.com': [{ login: 'other', active: true }],
              },
            }),
          };
        return { code: 0, stdout: `gho_${cmd.args[5]}\n` };
      },
      () => at,
    );
    expect(await gh.accounts('github.com')).toEqual(['work', 'personal']);
    expect(await gh.accounts('gitlab.com')).toEqual([]);
    expect(await gh.token('github.com', 'work')).toBe('gho_work');
    expect(await gh.token('github.com', 'work')).toBe('gho_work');
    at = 11 * 60_000;
    await gh.token('github.com', 'work');
    const tokenCalls = calls.filter((c) => c[2] === 'token');
    expect(tokenCalls).toEqual([
      [
        '/opt/homebrew/bin/gh',
        'auth',
        'token',
        '--hostname',
        'github.com',
        '--user',
        'work',
      ],
      [
        '/opt/homebrew/bin/gh',
        'auth',
        'token',
        '--hostname',
        'github.com',
        '--user',
        'work',
      ],
    ]);
    expect(calls.filter((c) => c[0] === 'probe')).toHaveLength(1);
  });

  it('is no account when gh is not there', async () => {
    const gh = ghCli(platform, async () => ({ code: 1, stdout: '' }));
    expect(await gh.accounts('github.com')).toEqual([]);
    expect(await gh.token('github.com', 'work')).toBeNull();
  });
});

describe('RepoTokenStore and repoBrainEnv', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-repo-tokens-'));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  const crypto = {
    available: async () => true,
    encrypt: async (plain: string) => Buffer.from(`enc:${plain}`),
    decrypt: async (c: Buffer) => c.toString().replace(/^enc:/, ''),
  };

  it('keeps a token per brain encrypted, and forgets it', async () => {
    const file = path.join(root, 'tokens.json');
    const store = new RepoTokenStore(file, crypto);
    await store.load();
    await store.set('b1', 'secret-token');
    expect(await fs.readFile(file, 'utf8')).not.toContain('secret-token');
    const again = new RepoTokenStore(file, crypto);
    await again.load();
    expect(await again.get('b1')).toBe('secret-token');
    expect(await again.get('b2')).toBeNull();
    await again.delete('b1');
    expect(await again.get('b1')).toBeNull();
  });

  it("gives git a brain's recorded sign-in, and nothing for any other folder", async () => {
    const d = deps();
    await d.tokens.set('t', 'typed');
    const sharing = (signIn: unknown, home = 'repo') =>
      ({ home, remoteUrl: repo.remoteUrl, signIn }) as never;
    const brains = [
      {
        id: 'g',
        path: '/brains/g',
        sharing: sharing({ kind: 'gh', user: 'work' }),
      },
      { id: 't', path: '/brains/t', sharing: sharing({ kind: 'token' }) },
      { id: 'm', path: '/brains/m', sharing: sharing(null) },
      { id: 'a', path: '/brains/a', sharing: sharing(null, 'customer') },
    ];
    expect(headerOf(await repoBrainEnv(d, brains, '/brains/g'))).toBe(
      header('x-access-token', 'token-of-work'),
    );
    expect(headerOf(await repoBrainEnv(d, brains, '/brains/t'))).toBe(
      header('x-access-token', 'typed'),
    );
    expect(await repoBrainEnv(d, brains, '/brains/m')).toBeNull();
    expect(await repoBrainEnv(d, brains, '/brains/a')).toBeNull();
    expect(await repoBrainEnv(d, brains, '/elsewhere')).toBeNull();
  });
});
