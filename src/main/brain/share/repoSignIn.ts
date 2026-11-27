/**
 * How git signs in to a shared brain's repo on a host of the person's own (GitHub, …). Git as it is on the machine
 * comes first; a machine signed in with another account (two GitHub accounts, the credential helper holding the
 * wrong one) is answered "not found", so each account the GitHub CLI knows is tried next, and a typed token last.
 * A token reaches git as an `http.<url>.extraHeader` through its environment, never its command line.
 */
import { z } from 'zod';
import type { Brain, BrainRepoSignIn } from '../../../shared/brain';
import { parseRepoUrl, type RepoAddress } from '../../../shared/brainShare';
import { isGitAuthFailure } from '../../../shared/gitAuth';
import type { Platform } from '../../platform/Platform';
import { runProbe, type ProbeRunner } from '../../services/agentDetector';
import {
  TokenUnavailableError,
  type TokenCrypto,
} from '../../services/ConnectionStore';
import { GitError, type GitClient } from '../../services/GitClient';
import { extraHeaderEnv } from '../../services/gitAuth';
import { samePath } from '../../paths';
import { JsonFileStore } from '../../usage/JsonFileStore';

const BATCH_SSH = { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
const GH_TIMEOUT_MS = 15_000;
const GH_TOKEN_TTL_MS = 10 * 60_000;

/** The GitHub CLI's accounts on this machine, and the token of one. */
export type GhCli = {
  accounts(host: string): Promise<string[]>;
  token(host: string, user: string): Promise<string | null>;
};

/** Typed tokens, encrypted, per brain. */
export type RepoTokens = {
  get(brainId: string): Promise<string | null>;
  set(brainId: string, token: string): Promise<void>;
  delete(brainId: string): Promise<void>;
};

export type RepoSignInDeps = { gh: GhCli; tokens: RepoTokens };

/** The header's scope: every repo of that owner on that host. Null for ssh: a token is for https. */
const scopeOf = (repo: RepoAddress): string | null =>
  /^https:\/\//i.test(repo.remoteUrl)
    ? `https://${repo.host}/${repo.owner}/`
    : null;

/** Git's environment for a token on an https repo (GitHub and GitLab take any user name with a token as password). */
export function tokenEnv(
  repo: RepoAddress,
  token: string,
): Record<string, string> {
  const scope = scopeOf(repo);
  return scope
    ? extraHeaderEnv(scope, token, process.env, 'x-access-token')
    : {};
}

/** Git answered that it may not, or cannot, see the repo: a private repo is "not found" to the wrong account. */
export const isAccessFailure = (e: unknown): boolean => {
  const stderr = e instanceof GitError ? e.stderr : '';
  return (
    isGitAuthFailure(stderr) ||
    /repository not found|permission denied|could not read from remote|returned error: 404|unable to get password/i.test(
      stderr,
    )
  );
};

/** Why git could not reach a repo of the person's own, in words that say what to do. */
export function cantReach(repo: RepoAddress, e: unknown): string {
  const stderr = e instanceof GitError ? e.stderr.trim() : '';
  const where = `${repo.owner}/${repo.name} on ${repo.host}`;
  if (isAccessFailure(e))
    return `Git on this machine can't open ${where}. Check the address and that you have access, and sign git in to ${repo.host} (for GitHub: "gh auth login", or Git Credential Manager).`;
  return `Can't reach ${where}: ${stderr || (e as Error).message}`;
}

export type FoundSignIn = {
  /** Null: git as it is on the machine. */
  signIn: BrainRepoSignIn | null;
  env: Record<string, string>;
  /** `git ls-remote --heads`: empty for a repo with nothing in it. */
  heads: string;
};

/** Nothing here opens the repo; `tried` names what was tried, for the person to read. */
export type NeedsToken = { needsToken: true; tried: string[] };

/**
 * Finds a sign-in that opens the repo: the typed `token` alone when one is given; else git as it is, then each
 * GitHub CLI account of the host. `needsToken`: an https repo nothing here can open, so the person types a token.
 * A failure that is not about access (offline, a wrong host) throws at once, as does a repo over ssh nothing opens.
 */
export async function findSignIn(
  d: RepoSignInDeps | undefined,
  git: GitClient,
  cwd: string,
  repo: RepoAddress,
  token?: string,
): Promise<(FoundSignIn & { needsToken?: false }) | NeedsToken> {
  const heads = (env: Record<string, string>) =>
    git.run(cwd, ['ls-remote', '--heads', '--', repo.remoteUrl], {
      timeoutMs: git.fetchTimeoutMs,
      env: { ...BATCH_SSH, ...env },
    });
  const typed = token?.trim();
  const https = scopeOf(repo) !== null;
  if (typed && https) {
    const env = tokenEnv(repo, typed);
    try {
      return { signIn: { kind: 'token' }, env, heads: await heads(env) };
    } catch (e) {
      if (!isAccessFailure(e)) throw new Error(cantReach(repo, e));
      throw new Error(
        `That token can't open ${repo.owner}/${repo.name} on ${repo.host}. It needs read and write access to the repo's contents.`,
      );
    }
  }
  let first: unknown;
  try {
    return { signIn: null, env: {}, heads: await heads({}) };
  } catch (e) {
    if (!isAccessFailure(e) || !https || !d)
      throw new Error(cantReach(repo, e));
    first = e;
  }
  const tried = ['git as it is signed in on this machine'];
  const accounts = await d.gh.accounts(repo.host).catch(() => []);
  if (!accounts.length)
    tried.push(`the GitHub CLI (no account for ${repo.host} found)`);
  for (const user of accounts) {
    tried.push(`the GitHub CLI account ${user}`);
    const t = await d.gh.token(repo.host, user).catch(() => null);
    if (!t) continue;
    const env = tokenEnv(repo, t);
    try {
      return { signIn: { kind: 'gh', user }, env, heads: await heads(env) };
    } catch (e) {
      if (!isAccessFailure(e)) throw new Error(cantReach(repo, first));
    }
  }
  return { needsToken: true, tried };
}

/** Git's environment for a brain's recorded sign-in; empty when its token cannot be had (git then answers itself). */
export async function signInEnv(
  d: RepoSignInDeps,
  brainId: string,
  signIn: BrainRepoSignIn | null | undefined,
  repo: RepoAddress,
): Promise<Record<string, string>> {
  if (!signIn) return {};
  const token =
    signIn.kind === 'gh'
      ? await d.gh.token(repo.host, signIn.user).catch(() => null)
      : await d.tokens.get(brainId).catch(() => null);
  return token ? tokenEnv(repo, token) : {};
}

/**
 * Git's environment for a network command run in `cwd` when that is the folder of a brain shared in a repo of the
 * person's own with a recorded sign-in; null for every other folder (Azure Repos signs in its own way).
 */
export async function repoBrainEnv(
  d: RepoSignInDeps,
  brains: Pick<Brain, 'id' | 'path' | 'sharing'>[],
  cwd: string,
): Promise<Record<string, string> | null> {
  const brain = brains.find((b) => samePath(b.path, cwd));
  const sharing = brain?.sharing;
  if (!brain || sharing?.home !== 'repo' || !sharing.signIn) return null;
  const repo = parseRepoUrl(sharing.remoteUrl);
  return repo ? signInEnv(d, brain.id, sharing.signIn, repo) : null;
}

/**
 * The GitHub CLI, found on the person's PATH as the agents are. No `gh`, or one that answers nothing, is no account.
 * A token is kept in memory for ten minutes, so a sync does not start `gh` each time.
 */
export function ghCli(
  platform: Pick<Platform, 'probeCommand'>,
  run: ProbeRunner = runProbe,
  now: () => number = Date.now,
): GhCli {
  let found: Promise<string | null> | null = null;
  const tokens = new Map<string, { token: string; at: number }>();
  const gh = () =>
    (found ??= run(platform.probeCommand('gh'), GH_TIMEOUT_MS).then(
      (r) =>
        r.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(l)) ?? null,
      () => null,
    ));
  const call = async (args: string[]): Promise<string | null> => {
    const command = await gh();
    if (!command) return null;
    return run({ command, args }, GH_TIMEOUT_MS).then(
      (r) => r.stdout,
      () => null,
    );
  };
  return {
    accounts: async (host) => {
      // The exit code is non-zero when any one account's token went bad; the list is still printed.
      const out = await call(['auth', 'status', '--json', 'hosts']);
      if (!out) return [];
      try {
        const parsed = JSON.parse(out) as {
          hosts?: Record<string, { login?: unknown; active?: unknown }[]>;
        };
        const list = parsed.hosts?.[host] ?? [];
        return [...list]
          .sort((a, b) => Number(b.active === true) - Number(a.active === true))
          .map((a) => a.login)
          .filter((l): l is string => typeof l === 'string' && l.length > 0);
      } catch {
        return [];
      }
    },
    token: async (host, user) => {
      const key = `${host}\n${user}`;
      const kept = tokens.get(key);
      if (kept && now() - kept.at < GH_TOKEN_TTL_MS) return kept.token;
      const out = await call([
        'auth',
        'token',
        '--hostname',
        host,
        '--user',
        user,
      ]);
      const token = out?.trim().split(/\s+/)[0] ?? '';
      if (!token) return null;
      tokens.set(key, { token, at: now() });
      return token;
    },
  };
}

const FileSchema = z.object({
  version: z.literal(1),
  tokens: z.record(z.string(), z.string()),
});

/** Tokens typed for a brain's repo, encrypted with safeStorage like a connection's (`brain-repo-tokens.json`). */
export class RepoTokenStore implements RepoTokens {
  private readonly store: JsonFileStore<z.infer<typeof FileSchema>>;

  constructor(
    filePath: string,
    private readonly crypto: TokenCrypto,
  ) {
    this.store = new JsonFileStore(filePath, FileSchema, () => ({
      version: 1,
      tokens: {},
    }));
  }

  load(): Promise<{ recovered: boolean; backup?: string }> {
    return this.store.load();
  }

  async get(brainId: string): Promise<string | null> {
    const c = this.store.value.tokens[brainId];
    if (!c) return null;
    return this.crypto.decrypt(Buffer.from(c, 'base64'));
  }

  async set(brainId: string, token: string): Promise<void> {
    if (!(await this.crypto.available()))
      throw new TokenUnavailableError(
        'Token encryption is not available on this machine; the token was not saved',
      );
    const c = (await this.crypto.encrypt(token)).toString('base64');
    await this.store.update((f) => {
      f.tokens[brainId] = c;
    });
  }

  async delete(brainId: string): Promise<void> {
    if (!(brainId in this.store.value.tokens)) return;
    await this.store.update((f) => {
      delete f.tokens[brainId];
    });
  }
}
