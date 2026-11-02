import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Environment, GivenTo } from '../../shared/secrets';
import type { ShellieConfig, TerminalDef } from '../../shared/types';
import { environmentOf, parseJsonc } from './classify';
import { isRecord } from './sources/types';

/** Who gets a secret when it is imported: Setup, Dev server and Tests; the user's shell is ticked by hand. */
export const DEFAULT_GIVEN_TO: GivenTo[] = ['setup', 'run', 'tests'];

/** Which "given to" a tab is; agent tabs are none, so they never get a secret. */
export function givenToFor(
  def: TerminalDef,
  testCommand: string | null,
): GivenTo | null {
  if (def.kind === 'shell') return 'shell';
  if (def.kind !== 'run') return null;
  if (def.setupCommands) return 'setup';
  if (testCommand !== null && def.command?.trim() === testCommand.trim())
    return 'tests';
  return 'run';
}

/**
 * Whether a tab holds secrets: a stored secret with a value is given to its "given to" (a run tab may be the
 * tests tab, so Tests counts for it too). The framework's environment name alone does not count, so a tab that
 * gets nothing is never stopped or restarted for a switch, an expiry or Finish.
 */
export function holdsSecrets(
  def: TerminalDef,
  secrets: {
    givenTo: GivenTo[];
    values: Partial<Record<Environment, unknown>>;
  }[],
): boolean {
  const given = givenToFor(def, null);
  if (given === null) return false;
  const wanted: GivenTo[] = given === 'run' ? ['run', 'tests'] : [given];
  return secrets.some(
    (v) =>
      Object.values(v.values).some(Boolean) &&
      v.givenTo.some((g) => wanted.includes(g)),
  );
}

const FRAMEWORK_NAME: Record<Environment, string> = {
  development: 'Development',
  test: 'Test',
  uat: 'Uat',
  production: 'Production',
};

/**
 * The env a tab gets: the values given to it (environment variables, never a shell line, so they arrive as they
 * are) and the framework's environment name. A secret without a value for the environment is left unset.
 */
export function secretsEnv(
  values: Record<string, { value: string; givenTo: GivenTo[] }>,
  given: GivenTo | null,
  env: Environment,
): Record<string, string> {
  if (given === null) return {};
  const out: Record<string, string> = {
    ASPNETCORE_ENVIRONMENT: FRAMEWORK_NAME[env],
    DOTNET_ENVIRONMENT: FRAMEWORK_NAME[env],
  };
  // Not for Setup (`npm ci` skips devDependencies on production) or Tests (test runners set their own mode).
  if (
    (given === 'run' || given === 'shell') &&
    (env === 'development' || env === 'production')
  )
    out.NODE_ENV = env;
  for (const [name, v] of Object.entries(values))
    if (v.givenTo.includes(given)) out[name] = v.value;
  return out;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj']);

/** The repo's test command: a `run:` entry named `test`, else `npm test`, else `dotnet test` for a test project. */
export async function testCommandFor(
  repoPath: string,
  config: ShellieConfig,
): Promise<string | null> {
  if (config.run.test) return config.run.test;
  try {
    const pkg: unknown = JSON.parse(
      await fs.readFile(path.join(repoPath, 'package.json'), 'utf8'),
    );
    if (isRecord(pkg) && isRecord(pkg.scripts) && pkg.scripts.test)
      return 'npm test';
  } catch {
    // No package.json, or not JSON.
  }
  return (await hasTestProject(repoPath, 3)) ? 'dotnet test' : null;
}

async function hasTestProject(dir: string, depth: number): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some((e) => e.isFile() && e.name.endsWith('Tests.csproj')))
    return true;
  if (depth === 0) return false;
  for (const e of entries)
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      if (await hasTestProject(path.join(dir, e.name), depth - 1)) return true;
  return false;
}

const DOTNET_RUN = /^\s*dotnet\s+run(?=\s|$)/;
const ENV_VARS = ['ASPNETCORE_ENVIRONMENT', 'DOTNET_ENVIRONMENT'];

/**
 * `--launch-profile <name>` for a `dotnet run` command when a launch profile in `Properties/launchSettings.json`
 * (the repo's root or one folder down) maps to the environment: by its ASPNETCORE_ENVIRONMENT, else its name.
 */
export function launchProfileArgs(
  command: string,
  repoPath: string,
  env: Environment,
): string[] {
  const profile = launchProfileFor(command, repoPath, env);
  return profile ? ['--launch-profile', profile.name] : [];
}

/** The launch profile `launchProfileArgs` picks, with its string environment variables (which win over ours). */
export function launchProfileFor(
  command: string,
  repoPath: string,
  env: Environment,
): { name: string; vars: Record<string, string> } | null {
  if (
    !DOTNET_RUN.test(command) ||
    /--launch-profile\b|(^|\s)-lp\b/.test(command)
  )
    return null;
  for (const file of launchSettingsFiles(repoPath)) {
    let json: unknown;
    try {
      json = parseJsonc(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!isRecord(json) || !isRecord(json.profiles)) continue;
    for (const [name, p] of Object.entries(json.profiles)) {
      if (!isRecord(p)) continue;
      // `dotnet run` only runs Project profiles.
      if (p.commandName !== undefined && p.commandName !== 'Project') continue;
      if (/["`$%]/.test(name)) continue;
      const vars = isRecord(p.environmentVariables)
        ? p.environmentVariables
        : {};
      const named = ENV_VARS.map((k) => vars[k]).find(
        (v): v is string => typeof v === 'string',
      );
      const mapped =
        (named ? environmentOf(named) : null) ?? environmentOf(name);
      if (mapped === env)
        return {
          name,
          vars: Object.fromEntries(
            Object.entries(vars).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          ),
        };
    }
  }
  return null;
}

function launchSettingsFiles(repoPath: string): string[] {
  const rel = path.join('Properties', 'launchSettings.json');
  const out = [path.join(repoPath, rel)];
  try {
    for (const e of readdirSync(repoPath, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    ))
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
        out.push(path.join(repoPath, e.name, rel));
  } catch {
    // Not a folder: no launch settings.
  }
  return out.filter((f) => existsSync(f));
}

/** Puts the args right after `dotnet run`, so `-- app args` stay the app's; a name with spaces is quoted. */
export function withLaunchProfile(command: string, args: string[]): string {
  if (args.length === 0) return command;
  const quoted = args.map((a) => (/^[\w.-]+$/.test(a) ? a : `"${a}"`));
  return command.replace(DOTNET_RUN, (m) => `${m} ${quoted.join(' ')}`);
}

/** How a file is stripped: `.env` lines, JSON keys, or Azure Functions' `local.settings.json` (Values unprefixed). */
export type StripKind = 'dotenv' | 'json' | 'localSettings';

/**
 * How a copied file is stripped of stored keys, by its repo-relative path; null leaves it alone. JSON only for
 * settings files and files under a `secrets/` folder, so other copied JSON is never rewritten.
 */
export function strippableKind(file: string): StripKind | null {
  const parts = file.toLowerCase().split(/[\\/]/);
  const base = parts.at(-1)!;
  if (base.startsWith('.shellie-tmp-')) return null;
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env'))
    return 'dotenv';
  if (!base.endsWith('.json')) return null;
  if (base === 'local.settings.json') return 'localSettings';
  return /^appsettings\b.*\.json$/.test(base) ||
    base.endsWith('.secrets.json') ||
    parts.slice(0, -1).includes('secrets')
    ? 'json'
    : null;
}

const DOTENV_LINE = /^\s*(?:export\s+)?([^\s=#]+)\s*=\s?(.*)$/;

/**
 * The text without the stored keys. `.env` style: the key's lines go (a quoted value may span lines, as
 * parseDotenv reads it) and every other byte stays. JSON: the keys (`A__B` for nesting) are removed and the file
 * is written again with 2-space indent, only when one was there.
 */
export function stripKeys(
  text: string,
  kind: StripKind,
  names: string[],
): string {
  if (names.length === 0) return text;
  const set = new Set(names);
  return kind === 'dotenv'
    ? stripDotenv(text, set)
    : stripJson(text, set, kind === 'localSettings');
}

function stripDotenv(text: string, names: Set<string>): string {
  const parts = text.split(/(?<=\n)/);
  const content = (i: number) => {
    const line = parts[i]!.replace(/\r?\n$/, '');
    return i === 0 ? line.replace(/^\uFEFF/, '') : line;
  };
  const keep: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const line = content(i);
    const m = /^\s*#/.test(line) ? null : DOTENV_LINE.exec(line);
    if (!m || !names.has(m[1]!)) {
      keep.push(parts[i]!);
      continue;
    }
    const rest = m[2]!.replace(/^\s+/, '');
    const q = rest[0];
    let last = i;
    if (q === '"' || q === "'" || q === '`') {
      let body = rest.slice(1);
      for (let n = i; ;) {
        if (closing(body, q) !== -1) {
          last = n;
          break;
        }
        n++;
        if (n >= parts.length) break;
        body += `\n${content(n)}`;
      }
    }
    // A BOM on the first line stays with the file.
    if (i === 0 && parts[0]!.startsWith('\uFEFF')) keep.push('\uFEFF');
    i = last;
  }
  return keep.join('');
}

function closing(body: string, q: string): number {
  for (let j = 0; j < body.length; j++) {
    if (q === '"' && body[j] === '\\') j++;
    else if (body[j] === q) return j;
  }
  return -1;
}

/** `localSettings`: discovery names a `Values` key without the `Values__` prefix, so `Values` is a root too. */
function stripJson(
  text: string,
  names: Set<string>,
  localSettings: boolean,
): string {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    try {
      json = parseJsonc(text);
    } catch {
      return text;
    }
  }
  const values =
    localSettings && json !== null && typeof json === 'object'
      ? (json as Record<string, unknown>).Values
      : undefined;
  const fromValues = removeKeys(values, '', names);
  if (!removeKeys(json, '', names) && !fromValues) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out = JSON.stringify(json, null, 2).replace(/\n/g, eol);
  return (
    (text.startsWith('\uFEFF') ? '\uFEFF' : '') +
    out +
    (/\r?\n$/.test(text) ? eol : '')
  );
}

function removeKeys(
  node: unknown,
  prefix: string,
  names: Set<string>,
): boolean {
  if (node === null || typeof node !== 'object') return false;
  let removed = false;
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (removeKeys(v, prefix === '' ? String(i) : `${prefix}__${i}`, names))
        removed = true;
    });
    return removed;
  }
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    const key = k.replaceAll(':', '__');
    const full = prefix === '' ? key : `${prefix}__${key}`;
    if (names.has(full) && (v === null || typeof v !== 'object')) {
      delete obj[k];
      removed = true;
    } else if (removeKeys(v, full, names)) removed = true;
  }
  return removed;
}
