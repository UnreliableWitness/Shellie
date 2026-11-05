import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import type { RepoFacts } from '../../shared/repoInspection';
import type { Connection } from '../../shared/types';
import {
  addOrigin,
  cleanupTempRepos,
  commitFile,
  git,
  makeRepo,
} from '../test-helpers/gitRepo';
import { GitClient } from './GitClient';
import { inspectRepo, proposeConfig } from './repoInspect';
import { ShellieYmlSchema } from './ShellieConfig';

afterAll(cleanupTempRepos);

const none: Omit<RepoFacts, 'existing'> = {
  lockfile: null,
  dotnet: [],
  devScript: null,
  apm: false,
  envFiles: [],
};

describe('proposeConfig', () => {
  it('writes the mockup YAML for npm, env files and a dev script', () => {
    const text = proposeConfig(
      {
        ...none,
        lockfile: 'npm',
        envFiles: ['.env', '.env.local'],
        devScript: 'dev',
      },
      'main',
    );
    expect(text).toBe(
      [
        'base: "main"',
        'branch: "{type}/{id}-{slug}"',
        'copy: [".env", ".env.local"]',
        'setup:',
        '  - npm ci',
        'run:',
        '  dev: npm run dev',
        '',
      ].join('\n'),
    );
    expect(ShellieYmlSchema.safeParse(parseYaml(text)).success).toBe(true);
  });

  it('uses the lockfile, adds dotnet restore after it, and npm start', () => {
    const text = proposeConfig(
      {
        ...none,
        lockfile: 'pnpm',
        dotnet: ['App.sln'],
        devScript: 'start',
        apm: true,
      },
      'develop',
    );
    expect(text).toContain('base: "develop"');
    expect(text).toContain(
      'setup:\n  - pnpm install --frozen-lockfile\n  - dotnet restore\n',
    );
    expect(text).toContain('  dev: npm start');
    expect(text).toContain('# apm.yml');
    expect(ShellieYmlSchema.safeParse(parseYaml(text)).success).toBe(true);
    expect(proposeConfig({ ...none, lockfile: 'yarn' }, 'main')).toContain(
      '  - yarn install --frozen-lockfile',
    );
  });

  it('quotes the base branch and env file names, so YAML reads them as strings', () => {
    const text = proposeConfig(
      { ...none, envFiles: ['.env #local', '.env.local'] },
      'null',
    );
    const parsed = ShellieYmlSchema.parse(parseYaml(text));
    expect(parsed.base).toBe('null');
    expect(parsed.copy).toEqual(['.env #local', '.env.local']);
  });

  it('leaves out copy, setup and run when nothing was found', () => {
    expect(proposeConfig(none, 'main')).toBe(
      'base: "main"\nbranch: "{type}/{id}-{slug}"\n',
    );
  });
});

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: 'c1',
  name: 'Contoso',
  organizationUrl: 'https://dev.azure.com/org',
  project: 'proj',
  user: null,
  status: 'ok',
  checkedAt: null,
  userUniqueName: null,
  provider: 'azure-devops',
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
  ...over,
});

const deps = { git: new GitClient(), connections: [conn()] };

function withRemote(url: string): string {
  const repo = makeRepo();
  git(repo, 'remote', 'add', 'origin', url);
  return repo;
}

describe('inspectRepo', () => {
  it('links an https Azure Repos remote to the matching connection', async () => {
    const repo = withRemote('https://dev.azure.com/org/proj/_git/repo');
    const r = await inspectRepo(repo, deps);
    expect(r.remote).toMatchObject({
      provider: 'azure-devops',
      connectionId: 'c1',
      project: 'proj',
    });
    expect(r.folder).toBe(repo);
  });

  it('links the SSH form too', async () => {
    const repo = withRemote('git@ssh.dev.azure.com:v3/org/proj/repo');
    expect((await inspectRepo(repo, deps)).remote).toMatchObject({
      provider: 'azure-devops',
      connectionId: 'c1',
    });
  });

  it('keeps an Azure remote of another organization unlinked', async () => {
    const repo = withRemote('https://dev.azure.com/other/proj/_git/repo');
    expect((await inspectRepo(repo, deps)).remote).toMatchObject({
      provider: 'azure-devops',
      connectionId: null,
    });
  });

  it('recognises GitHub and other hosts without a connection', async () => {
    const gh = await inspectRepo(
      withRemote('git@github.com:me/thing.git'),
      deps,
    );
    expect(gh.remote).toMatchObject({ provider: 'github', connectionId: null });
    const other = await inspectRepo(
      withRemote('https://git.example.com/a/b.git'),
      deps,
    );
    expect(other.remote?.provider).toBe('other');
  });

  it('has no remote without origin', async () => {
    expect((await inspectRepo(makeRepo(), deps)).remote).toBeNull();
  });

  it('rejects a folder that is not a git repository', async () => {
    const dir = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), 'shellie-plain-')),
    );
    // The message names no folder: IPC rejections reach telemetry, and the page shows the folder itself.
    const err = await inspectRepo(dir, deps).catch((e: Error) => e);
    expect((err as Error).message).toBe('Not a git repository');
  });

  it('reports an existing .shellie.yml and proposes nothing', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, '.shellie.yml'), 'base: dev\n');
    const r = await inspectRepo(repo, deps);
    expect(r.facts.existing).toBe('base: dev\n');
    expect(r.proposal).toBeNull();
  });

  it('lists only git-ignored env files and reads the stack', async () => {
    const repo = makeRepo();
    commitFile(repo, '.gitignore', '.env\n.env.local\n');
    writeFileSync(path.join(repo, '.env'), 'A=1');
    writeFileSync(path.join(repo, '.env.local'), 'A=1');
    writeFileSync(path.join(repo, '.env.example'), 'A=');
    commitFile(repo, 'package-lock.json', '{}');
    commitFile(
      repo,
      'package.json',
      JSON.stringify({ scripts: { start: 'node .' } }),
    );
    commitFile(repo, 'Shop.sln', '');
    commitFile(repo, 'apm.yml', 'x: 1\n');
    const r = await inspectRepo(repo, deps);
    expect(r.facts).toEqual({
      lockfile: 'npm',
      dotnet: ['Shop.sln'],
      devScript: 'start',
      apm: true,
      envFiles: ['.env', '.env.local'],
      existing: null,
    });
    expect(r.proposal).toContain('copy: [".env", ".env.local"]');
    expect(r.proposal).toContain('dotnet restore');
  });

  it('takes the base branch from origin/HEAD', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    git(repo, 'branch', '-m', 'main', 'develop');
    git(repo, 'push', '-q', '-u', 'origin', 'develop');
    git(repo, 'remote', 'set-head', 'origin', 'develop');
    expect((await inspectRepo(repo, deps)).baseBranch).toBe('develop');
  });

  it('falls back to main, and to the current branch without a main', async () => {
    expect((await inspectRepo(makeRepo(), deps)).baseBranch).toBe('main');
    const repo = makeRepo();
    git(repo, 'branch', '-m', 'main', 'trunk');
    expect((await inspectRepo(repo, deps)).baseBranch).toBe('trunk');
  });

  it('works from a subfolder and reports the repo root', async () => {
    const repo = makeRepo();
    mkdirSync(path.join(repo, 'sub'));
    expect((await inspectRepo(path.join(repo, 'sub'), deps)).folder).toBe(repo);
  });
});
