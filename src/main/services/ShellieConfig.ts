import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { RepoOverrides, ShellieConfig } from '../../shared/types';
import { OVERRIDE_KEYS, type OverrideKey } from '../../shared/repoConfig';
import { pathExists } from '../fsRetry';
import { GitClient } from './GitClient';
import {
  DEFAULT_BRANCH_TEMPLATE,
  ShellieYmlSchema,
} from '../../shared/shellieYml';

export { DEFAULT_BRANCH_TEMPLATE, ShellieYmlSchema };

export class ShellieConfigError extends Error {
  constructor(
    public readonly file: string,
    detail: string,
  ) {
    super(`${file}: ${detail}`);
    this.name = 'ShellieConfigError';
  }
}

/** `.shellie.yml`, else the pre-rename `.miac.yml`, else null. */
export async function configFileFor(repoPath: string): Promise<string | null> {
  for (const name of ['.shellie.yml', '.miac.yml']) {
    const file = path.join(repoPath, name);
    if (await pathExists(file)) return file;
  }
  return null;
}

type BaseGit = Pick<GitClient, 'defaultBaseRef' | 'currentBranch'>;
let defaultGit: GitClient | undefined;

/** The repo's own default branch (origin/HEAD, main, master, ...), for a config that sets no `base`. */
async function defaultBaseBranch(
  repoPath: string,
  git: BaseGit = (defaultGit ??= new GitClient()),
): Promise<string> {
  const ref = await git.defaultBaseRef(repoPath);
  if (ref === 'HEAD') return (await git.currentBranch(repoPath)) ?? 'main';
  return ref.replace(/^origin\//, '');
}

export async function loadShellieConfig(
  repoPath: string,
  git?: BaseGit,
): Promise<ShellieConfig> {
  return (await loadShellieFile(repoPath, git)).config;
}

/** What `.shellie.yml` gives: the config, the keys the file itself sets, and their values (Settings' "file value"). */
export type ShellieFile = {
  config: ShellieConfig;
  fileKeys: Set<OverrideKey>;
  file: Partial<RepoOverrides>;
};

/** The config when the file gives nothing: no file, or (Settings) a file that does not parse. */
export async function shellieDefaults(
  repoPath: string,
  found: boolean,
  git?: BaseGit,
): Promise<ShellieConfig> {
  return toConfig(
    ShellieYmlSchema.parse({}),
    await defaultSetupFor(repoPath),
    found,
    await defaultBaseBranch(repoPath, git),
  );
}

async function defaultSetupFor(repoPath: string): Promise<string[]> {
  return (await pathExists(path.join(repoPath, 'package-lock.json')))
    ? ['npm ci']
    : [];
}

/** Reads `.shellie.yml` once; throws `ShellieConfigError` when it is not valid. */
export async function loadShellieFile(
  repoPath: string,
  git?: BaseGit,
): Promise<ShellieFile> {
  const file = await configFileFor(repoPath);
  if (file === null)
    return {
      config: await shellieDefaults(repoPath, false, git),
      fileKeys: new Set(),
      file: {},
    };

  const text = await fs.readFile(file, 'utf8');
  let doc: unknown;
  try {
    doc = parseYaml(text) ?? {};
  } catch (e) {
    throw new ShellieConfigError(
      file,
      `not valid YAML: ${(e as Error).message}`,
    );
  }
  const parsed = ShellieYmlSchema.safeParse(doc);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(
        (i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`,
      )
      .join('; ');
    throw new ShellieConfigError(file, detail);
  }
  const config = toConfig(
    parsed.data,
    await defaultSetupFor(repoPath),
    true,
    parsed.data.base ?? (await defaultBaseBranch(repoPath, git)),
  );
  // A strict schema: every key of the parsed document is one the file sets.
  const raw = doc as Record<string, unknown>;
  const fileKeys = new Set<OverrideKey>();
  for (const k of OVERRIDE_KEYS) {
    const yamlKey = k === 'reviewCollapse' ? 'review' : k;
    if (raw[yamlKey] !== undefined) fileKeys.add(k);
  }
  const values: Partial<RepoOverrides> = {};
  for (const k of fileKeys) Object.assign(values, { [k]: config[k] });
  return { config, fileKeys, file: values };
}

function toConfig(
  c: z.infer<typeof ShellieYmlSchema>,
  defaultSetup: string[],
  found: boolean,
  base: string,
): ShellieConfig {
  return {
    base,
    branch: c.branch,
    copy: c.copy,
    copyAgentConfig: c.copyAgentConfig,
    setup: c.setup ?? defaultSetup,
    run: c.run,
    ...(c.apm !== undefined ? { apm: c.apm } : {}),
    ...(c.review ? { reviewCollapse: c.review.collapse } : {}),
    found,
  };
}

/** The `.shellie.yml` text for the keys where `effective` differs from `defaults` (what no file gives). */
export function configDiffYaml(
  effective: ShellieConfig,
  defaults: ShellieConfig,
): string {
  const differs = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  const doc: Record<string, unknown> = {};
  if (differs(effective.base, defaults.base)) doc.base = effective.base;
  if (differs(effective.branch, defaults.branch)) doc.branch = effective.branch;
  if (differs(effective.copy, defaults.copy)) doc.copy = effective.copy;
  if (
    differs(effective.copyAgentConfig ?? true, defaults.copyAgentConfig ?? true)
  )
    doc.copyAgentConfig = effective.copyAgentConfig ?? true;
  if (differs(effective.setup, defaults.setup)) doc.setup = effective.setup;
  if (differs(effective.run, defaults.run)) doc.run = effective.run;
  if (differs(effective.apm, defaults.apm)) doc.apm = effective.apm;
  if (differs(effective.reviewCollapse ?? [], defaults.reviewCollapse ?? []))
    doc.review = { collapse: effective.reviewCollapse };
  return Object.keys(doc).length === 0 ? '{}\n' : stringifyYaml(doc);
}
