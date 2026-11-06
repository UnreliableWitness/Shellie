import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ENVIRONMENTS,
  maskValue,
  type Environment,
  type Found,
  type ImportCandidate,
  type ImportCell,
  type ImportRequest,
  type ImportResult,
  type ImportRow,
  type ImportSource,
} from '../../shared/secrets';
import { isInside, toRel } from '../paths';
import type { GitClient } from '../services/GitClient';
import { fileEnvironment, type DiscoveryHold } from './discover';
import { DEFAULT_GIVEN_TO, strippableKind, stripKeys } from './inject';
import { replaceFile } from './replaceFile';
import type { SecretStore } from './SecretStore';

export type KeyedFound = Found & { key: string };

/** A stored secret's values, decrypted in main (null: unreadable), to compare with what discovery found. */
export type StoredValues = {
  name: string;
  values: Partial<
    Record<Environment, { value: string | null; source: string | null }>
  >;
};

const candidate = (f: KeyedFound): ImportCandidate => ({
  source: f.source,
  mask: maskValue(f.value),
  key: f.key,
  tracked: f.tracked,
});

/** One value per distinct value, the first source that had it. */
function distinct(found: KeyedFound[]): KeyedFound[] {
  const seen = new Set<string>();
  return found.filter((f) => !seen.has(f.value) && !!seen.add(f.value));
}

/**
 * The import page's rows: one per found name, a cell per environment against what the repo has stored. Two
 * sources with different values for one environment are a conflict (two candidates); one value in two sources is
 * not. Stored names match case-insensitively (the store allows one spelling per scope). Values the store holds
 * already are `same`; a cell where a value differs is `changed`, listing every source and marking the one that
 * matches the stored value; a gap says whether a value is stored. Masks and keys only: values stay in main.
 */
export function buildImportPlan(
  found: KeyedFound[],
  stored: StoredValues[],
): ImportRow[] {
  const names = [...new Set(found.map((f) => f.name))];
  return names.map((name) => {
    const mine = found.filter((f) => f.name === name);
    const have =
      stored.find((s) => s.name.toLowerCase() === name.toLowerCase())?.values ??
      {};
    const storedValues = new Set(
      Object.values(have)
        .map((v) => v?.value)
        .filter((v): v is string => typeof v === 'string'),
    );
    const cells = Object.fromEntries(
      ENVIRONMENTS.map((env): [Environment, ImportCell] => {
        const all = distinct(mine.filter((f) => f.env === env));
        const old = have[env];
        if (all.length === 0)
          return [env, { candidates: [], state: 'missing', stored: !!old }];
        if (!old)
          return [env, { candidates: all.map(candidate), state: 'new' }];
        const matches = (f: KeyedFound) => f.value === old.value;
        return all.every(matches)
          ? [env, { candidates: all.map(candidate), state: 'same' }]
          : [
              env,
              {
                candidates: all.map((f) =>
                  matches(f)
                    ? { ...candidate(f), matchesStored: true }
                    : candidate(f),
                ),
                state: 'changed',
                was: old.source,
              },
            ];
      }),
    ) as Record<Environment, ImportCell>;
    return {
      name,
      secretLike: mine.some((f) => f.secretLike),
      cells,
      unassigned: distinct(mine.filter((f) => f.env === null))
        .filter((f) => !storedValues.has(f.value))
        .map(candidate),
    };
  });
}

/** A source can lose imported keys only when it is an untracked `.env`-style file (never JSON, user secrets or git). */
export function importSources(found: KeyedFound[]): ImportSource[] {
  const sources = [...new Set(found.map((f) => f.source))];
  return sources.map((p) => {
    const tracked = found.some((f) => f.source === p && f.tracked);
    return {
      path: p,
      tracked,
      removable: !tracked && strippableKind(p) === 'dotenv',
    };
  });
}

const RequestSchema = z.object({
  repoId: z.string(),
  picks: z.array(
    z.object({ name: z.string(), env: z.enum(ENVIRONMENTS), key: z.string() }),
  ),
  rewriteWorktreeCopies: z.boolean(),
  removeFromMainCheckout: z.array(z.string()),
});

const STALE = 'The found values are out of date; look again';

export type ImportDeps = {
  hold: DiscoveryHold;
  store: SecretStore;
  git: GitClient;
  /** The repo's main checkout. */
  repoPath: string;
  /** Open tasks' worktrees of this repo, with the repo's `copy:` entries. */
  worktrees: () =>
    | { worktreePath: string; copy: string[] }[]
    | Promise<{ worktreePath: string; copy: string[] }[]>;
};

/**
 * Two picked names differ only in case. The message reaches notices and telemetry, so it names no secret; the
 * names are in `names` (the Import page finds the clash itself and shows them before sending).
 */
export class CaseClashError extends Error {
  constructor(readonly names: [string, string]) {
    super('Two picked names differ only in case; import one of them');
    this.name = 'CaseClashError';
  }
}

/**
 * Saves the picked values (resolved by key from what main holds, never sent by the renderer) into the repo's
 * secrets, with the default given-to for new ones. Then, when asked, rewrites open worktrees' copied files and
 * the chosen `.env`-style files of the main checkout without the imported keys, and forgets the held values.
 */
export async function importSecrets(
  raw: ImportRequest,
  deps: ImportDeps,
): Promise<ImportResult> {
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) throw new Error('The import is not valid');
  const req = parsed.data;
  const held = deps.hold.entries(req.repoId);
  const removable = new Set(
    importSources(held)
      .filter((s) => s.removable)
      .map((s) => s.path),
  );
  if (req.removeFromMainCheckout.some((f) => !removable.has(f)))
    throw new Error(
      'Shellie only removes values from .env-style files that are not in git',
    );

  const byName = new Map<
    string,
    Partial<Record<Environment, { value: string; source: string }>>
  >();
  for (const p of req.picks) {
    const f = deps.hold.resolve(req.repoId, p.key);
    if (!f || f.name !== p.name) throw new Error(STALE);
    const values = byName.get(p.name) ?? {};
    if (values[p.env])
      throw new Error('Pick one value per name and environment');
    values[p.env] = { value: f.value, source: f.source };
    byName.set(p.name, values);
  }
  const lower = new Map<string, string>();
  for (const name of byName.keys()) {
    const other = lower.get(name.toLowerCase());
    if (other !== undefined) throw new CaseClashError([other, name]);
    lower.set(name.toLowerCase(), name);
  }

  const existing = deps.store
    .list({ repoId: req.repoId })
    .filter((s) => s.scope !== 'all');
  for (const [name, values] of byName) {
    const current = existing.find(
      (s) => s.name.toLowerCase() === name.toLowerCase(),
    );
    await deps.store.save({
      id: current?.id,
      scope: { repoId: req.repoId },
      name: current?.name ?? name,
      givenTo: current?.givenTo ?? DEFAULT_GIVEN_TO,
      values,
    });
  }

  /** Names to take out of a copied file: those imported for its environment, all of them when it has none. */
  const namesFor = (env: Environment | null) =>
    [...byName]
      .filter(([, values]) => env === null || values[env] !== undefined)
      .map(([name]) => name);
  // Without git's list a tracked file cannot be told apart, so no file is rewritten at all.
  const tracked = await trackedFiles(deps.git, deps.repoPath);
  let worktreesRewritten = 0;
  if (tracked && req.rewriteWorktreeCopies && byName.size > 0)
    for (const w of await deps.worktrees()) {
      let changed = false;
      for (const rel of w.copy) {
        const target = path.resolve(w.worktreePath, rel);
        if (!isInside(w.worktreePath, target)) continue;
        if (await stripTree(w.worktreePath, target, namesFor, tracked))
          changed = true;
      }
      if (changed) worktreesRewritten++;
    }

  const filesChanged: string[] = [];
  for (const file of tracked ? req.removeFromMainCheckout : []) {
    // Only the keys whose value in this file is the one imported, so a value left behind is never lost.
    const imported = held.filter(
      (f) =>
        f.source === file &&
        Object.values(byName.get(f.name) ?? {}).some(
          (v) => v.value === f.value,
        ),
    );
    if (imported.length === 0 || tracked?.has(file)) continue;
    const target = path.resolve(deps.repoPath, file);
    if (!isInside(deps.repoPath, target)) continue;
    const st = await fs.lstat(target).catch(() => null);
    if (!st?.isFile()) continue;
    const text = await fs.readFile(target, 'utf8');
    const stripped = stripKeys(
      text,
      'dotenv',
      imported.map((f) => f.name),
    );
    if (stripped === text) continue;
    await replaceFile(target, stripped);
    filesChanged.push(file);
  }

  deps.hold.drop(req.repoId);
  return { values: req.picks.length, worktreesRewritten, filesChanged };
}

async function trackedFiles(
  git: GitClient,
  repoPath: string,
): Promise<Set<string> | null> {
  try {
    const out = await git.run(repoPath, ['ls-files', '-z']);
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

/** Strips the names from a copied file, or the files of a copied folder; true when one changed. Never a tracked file. */
async function stripTree(
  root: string,
  target: string,
  names: (env: Environment | null) => string[],
  tracked: Set<string>,
): Promise<boolean> {
  const st = await fs.lstat(target).catch(() => null);
  if (!st) return false;
  if (st.isDirectory()) {
    let changed = false;
    for (const e of await fs.readdir(target))
      if (e !== 'node_modules' && e !== '.git')
        if (await stripTree(root, path.join(target, e), names, tracked))
          changed = true;
    return changed;
  }
  if (!st.isFile()) return false;
  const rel = toRel(root, target);
  const kind = strippableKind(rel);
  if (!kind || tracked.has(rel)) return false;
  const text = await fs.readFile(target, 'utf8');
  const stripped = stripKeys(text, kind, names(fileEnvironment(rel)));
  if (stripped === text) return false;
  await replaceFile(target, stripped);
  return true;
}
