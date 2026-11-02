import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  GivenTo,
  SecretsReason,
  SecretsStatus,
} from '../../shared/secrets';
import type { GitClient } from '../services/GitClient';
import { isInside } from '../paths';
import { discoverSecrets } from './discover';
import { replaceFile } from './replaceFile';
import { type StripKind, strippableKind, stripKeys } from './inject';
import type { SecretStore } from './SecretStore';

export type StatusDeps = {
  repoId: string;
  repoPath: string;
  /** The repo's `copy:` entries (files or folders). */
  copy: string[];
  store: SecretStore;
  git: GitClient;
  userSecretsDir: (id: string) => string | null;
  /** Open (not done) tasks' worktrees of this repo. */
  worktrees: { taskId: string; worktreePath: string }[];
};

/** The files git tracks under `root`; null when git cannot say (never an empty set: that would read as "none"). */
export async function trackedIn(
  git: GitClient,
  root: string,
): Promise<Set<string> | null> {
  try {
    const out = await git.run(root, ['ls-files', '-z']);
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Visits the copied files under `root` that are not tracked, with their repo-relative path (`/`). A file or folder
 * that vanished or cannot be read is skipped on its own. Returns the paths whose visit said true.
 */
async function walk(
  root: string,
  copy: string[],
  tracked: Set<string>,
  visit: (abs: string, rel: string, kind: StripKind) => Promise<boolean>,
): Promise<string[]> {
  const hits: string[] = [];
  const one = async (target: string): Promise<void> => {
    try {
      const st = await fs.lstat(target);
      if (st.isDirectory()) {
        for (const e of await fs.readdir(target))
          if (e !== 'node_modules' && e !== '.git')
            await one(path.join(target, e));
        return;
      }
      if (!st.isFile()) return;
      const rel = path.relative(root, target).split(path.sep).join('/');
      const kind = strippableKind(rel);
      if (!kind || tracked.has(rel)) return;
      if (await visit(target, rel, kind)) hits.push(rel);
    } catch {
      // Gone or unreadable: this one is skipped.
    }
  };
  for (const entry of copy) {
    const target = path.resolve(root, entry);
    if (isInside(root, target)) await one(target);
  }
  return hits;
}

/** The copied files holding a stored key, with how many of the stored names they hold between them. */
export async function holding(
  root: string,
  copy: string[],
  names: string[],
  tracked: Set<string>,
): Promise<{ files: string[]; count: number }> {
  const held = new Set<string>();
  const files = await walk(root, copy, tracked, async (abs, _rel, kind) => {
    const text = await fs.readFile(abs, 'utf8');
    let any = false;
    for (const n of names)
      if (stripKeys(text, kind, [n]) !== text) {
        held.add(n);
        any = true;
      }
    return any;
  });
  return { files, count: held.size };
}

/**
 * Rewrites the copied files of a worktree without the stored keys. True when a file changed. A worktree whose
 * tracked files git cannot list is left alone.
 */
export async function cleanWorktree(
  worktreePath: string,
  copy: string[],
  names: string[],
  git: GitClient,
): Promise<boolean> {
  if (names.length === 0) return false;
  const tracked = await trackedIn(git, worktreePath);
  if (!tracked) return false;
  const changed = await walk(
    worktreePath,
    copy,
    tracked,
    async (abs, _r, kind) => {
      const text = await fs.readFile(abs, 'utf8');
      const stripped = stripKeys(text, kind, names);
      if (stripped === text) return false;
      await replaceFile(abs, stripped);
      return true;
    },
  );
  return changed.length > 0;
}

/**
 * Cleans each worktree with `clean`; one that throws is skipped and the rest go on. Returns the task ids that
 * changed, once each (a task can have several workspaces of the repo).
 */
export async function cleanAll(
  worktrees: StatusDeps['worktrees'],
  clean: (worktreePath: string) => Promise<boolean>,
): Promise<string[]> {
  const cleaned: string[] = [];
  for (const w of worktrees) {
    try {
      if ((await clean(w.worktreePath)) && !cleaned.includes(w.taskId))
        cleaned.push(w.taskId);
    } catch {
      // This worktree stays as it was; the others are still cleaned.
    }
  }
  return cleaned;
}

/** The open tasks whose worktree copy still holds a stored key (a worktree git cannot read is not reported). */
export async function dirtyWorktrees(
  worktrees: StatusDeps['worktrees'],
  copy: string[],
  names: string[],
  git: GitClient,
): Promise<{ taskIds: string[]; unchecked: boolean }> {
  const out: string[] = [];
  let unchecked = false;
  for (const w of worktrees) {
    const tracked = await trackedIn(git, w.worktreePath);
    if (!tracked) {
      unchecked = true;
      continue;
    }
    if (
      (await holding(w.worktreePath, copy, names, tracked)).files.length > 0 &&
      !out.includes(w.taskId)
    )
      out.push(w.taskId);
  }
  return { taskIds: out, unchecked };
}

/** The distinct names of every value stored for a repo (its own and All repositories). */
export function storedNames(store: SecretStore, repoId: string): string[] {
  return [...new Set(store.allValues([repoId]).map((v) => v.name))];
}

/**
 * Whether the repo's secrets are protected. `empty` when nothing is stored (a plain .env of non-secrets is nothing
 * to protect); `protected` only when no `copy:` file, no open task's copy and no tracked file holds a stored value.
 */
export async function computeStatus(deps: StatusDeps): Promise<SecretsStatus> {
  const stored = deps.store.allValues([deps.repoId]);
  if (stored.length === 0)
    return { state: 'empty', reasons: [], given: [], secrets: 0 };
  const names = [...new Set(stored.map((v) => v.name))];
  const values = new Set(stored.map((v) => v.value));
  const reasons: SecretsReason[] = [];

  const tracked = await trackedIn(deps.git, deps.repoPath);
  let unchecked = tracked === null;
  if (tracked) {
    const copied = await holding(deps.repoPath, deps.copy, names, tracked);
    if (copied.files.length > 0)
      reasons.push({ kind: 'copy', files: copied.files, count: copied.count });
  }

  const found = await discoverSecrets(deps.repoPath, {
    git: deps.git,
    userSecretsDir: deps.userSecretsDir,
  }).catch(() => null);
  if (!found) unchecked = true;
  const committed = [
    ...new Set(
      (found?.found ?? [])
        .filter((f) => f.tracked && values.has(f.value))
        .map((f) => f.source),
    ),
  ];
  if (committed.length > 0) reasons.push({ kind: 'tracked', files: committed });

  const dirty = await dirtyWorktrees(
    deps.worktrees,
    deps.copy,
    names,
    deps.git,
  );
  if (dirty.taskIds.length > 0)
    reasons.push({ kind: 'worktrees', taskIds: dirty.taskIds });
  if (dirty.unchecked) unchecked = true;
  // Never green on something Shellie could not look at.
  if (unchecked) reasons.push({ kind: 'unchecked' });

  const given = [
    ...new Set(
      deps.store
        .list({ repoId: deps.repoId })
        .filter((v) => Object.keys(v.values).length > 0)
        .flatMap((v) => v.givenTo),
    ),
  ] as GivenTo[];
  return {
    state: reasons.length === 0 ? 'protected' : 'attention',
    reasons,
    given,
    secrets: names.length,
  };
}
