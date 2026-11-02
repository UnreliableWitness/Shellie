import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Connection } from '../../shared/types';
import type { RepoFacts, RepoInspection } from '../../shared/repoInspection';
import { pathExists } from '../fsRetry';
import { matchConnection, parseAzureReposRemote } from './azureRepos';
import type { GitClient } from './GitClient';
import { configFileFor, DEFAULT_BRANCH_TEMPLATE } from './ShellieConfig';

const INSTALL = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --frozen-lockfile',
} as const;

/** The `.shellie.yml` text for what was found (pure). */
export function proposeConfig(
  facts: Omit<RepoFacts, 'existing'> & { existing?: string | null },
  baseBranch: string,
): string {
  // Quoted, so a branch named `null` or `1.0` and a file name with `#` or `: ` stay strings.
  const lines = [
    `base: ${JSON.stringify(baseBranch)}`,
    `branch: "${DEFAULT_BRANCH_TEMPLATE}"`,
  ];
  if (facts.envFiles.length > 0)
    lines.push(
      `copy: [${facts.envFiles.map((f) => JSON.stringify(f)).join(', ')}]`,
    );
  const setup: string[] = [];
  if (facts.lockfile) setup.push(INSTALL[facts.lockfile]);
  if (facts.dotnet.length > 0) setup.push('dotnet restore');
  if (setup.length > 0) lines.push('setup:', ...setup.map((c) => `  - ${c}`));
  if (facts.devScript)
    lines.push(
      'run:',
      `  dev: ${facts.devScript === 'dev' ? 'npm run dev' : 'npm start'}`,
    );
  if (facts.apm)
    lines.push(
      '# apm.yml found: agent packages are installed by Shellie (set apm: false to skip)',
    );
  return `${lines.join('\n')}\n`;
}

/** The git-ignored `.env*` and `appsettings.*.local.json` files in a repo's top folder, sorted. */
export async function findEnvCandidates(
  top: string,
  git: Pick<GitClient, 'run'>,
  entries?: string[],
): Promise<string[]> {
  const names = entries ?? (await fs.readdir(top));
  const candidates = names
    .filter(
      (e) => e.startsWith('.env') || /^appsettings\..+\.local\.json$/i.test(e),
    )
    .sort();
  if (candidates.length === 0) return [];
  try {
    const ignored = new Set(
      (await git.run(top, ['check-ignore', '--', ...candidates]))
        .split(/\r?\n/)
        .filter(Boolean),
    );
    return candidates.filter((c) => ignored.has(c));
  } catch {
    // check-ignore exits 1 when nothing is ignored
    return [];
  }
}

async function readFacts(
  git: GitClient,
  top: string,
): Promise<{ facts: RepoFacts; existingFile: string | null }> {
  const entries = await fs.readdir(top);
  const lockfile = (await pathExists(path.join(top, 'package-lock.json')))
    ? 'npm'
    : (await pathExists(path.join(top, 'pnpm-lock.yaml')))
      ? 'pnpm'
      : (await pathExists(path.join(top, 'yarn.lock')))
        ? 'yarn'
        : null;
  let devScript: RepoFacts['devScript'] = null;
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(top, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, unknown> };
    if (typeof pkg.scripts?.dev === 'string') devScript = 'dev';
    else if (typeof pkg.scripts?.start === 'string') devScript = 'start';
  } catch {
    // no or unreadable package.json
  }
  const envFiles = await findEnvCandidates(top, git, entries);
  const existingFile = await configFileFor(top);
  return {
    existingFile,
    facts: {
      lockfile,
      dotnet: entries.filter((e) => /\.(sln|csproj)$/i.test(e)).sort(),
      devScript,
      apm: entries.includes('apm.yml'),
      envFiles,
      existing: existingFile ? await fs.readFile(existingFile, 'utf8') : null,
    },
  };
}

export async function inspectRepo(
  folder: string,
  deps: { git: GitClient; connections: Connection[] },
): Promise<RepoInspection> {
  const { git } = deps;
  let top: string | null = null;
  try {
    top = await git.toplevel(await fs.realpath(folder));
  } catch {
    // missing folder
  }
  // No folder in the message: every IPC rejection is reported to telemetry, and the page shows the folder.
  if (!top) throw new Error('Not a git repository');

  const url = await git.remoteUrl(top, 'origin');
  let remote: RepoInspection['remote'] = null;
  if (url) {
    const azure = parseAzureReposRemote(url);
    const connection = azure ? matchConnection(url, deps.connections) : null;
    const github =
      /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]/i;
    remote = {
      url,
      provider: azure
        ? 'azure-devops'
        : github.test(url.trim())
          ? 'github'
          : 'other',
      connectionId: connection?.id ?? null,
      project: connection?.project ?? null,
    };
  }

  const ref = await git.defaultBaseRef(top);
  const baseBranch =
    ref === 'HEAD'
      ? ((await git.currentBranch(top)) ?? 'main')
      : ref.replace(/^origin\//, '');

  const { facts } = await readFacts(git, top);
  return {
    folder: top,
    remote,
    baseBranch,
    facts,
    proposal: facts.existing === null ? proposeConfig(facts, baseBranch) : null,
  };
}
