import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathExists } from '../fsRetry';
import type { GitClient } from '../services/GitClient';
import { samePath } from '../paths';

export type Candidate = {
  repoPath: string;
  worktreePath: string;
  branch: string | null;
  mainCheckout: boolean;
};

/** The nearest folder at or above `p` that exists (a written file may be gone, its folder usually is not). */
async function existingDir(p: string): Promise<string | null> {
  let cur = path.resolve(p);
  for (;;) {
    try {
      if ((await fs.stat(cur)).isDirectory()) return cur;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** The worktree containing `p`; null when it is not in a git repo. repoPath is the main checkout. */
export async function resolveCandidate(
  git: GitClient,
  p: string,
): Promise<Candidate | null> {
  const dir = await existingDir(p);
  if (!dir) return null;
  const worktreePath = await git.toplevel(dir);
  if (!worktreePath) return null;
  try {
    const repoPath = path.dirname(await git.commonDir(dir));
    return {
      repoPath,
      worktreePath,
      branch: await git.currentBranch(dir),
      mainCheckout: samePath(worktreePath, repoPath),
    };
  } catch {
    return null;
  }
}

const SCAN_CONCURRENCY = 8;

/**
 * Whether any checkout of the repo may be on `branch`, from the files git keeps: `.git/HEAD` for the main
 * checkout, `.git/worktrees/<name>/HEAD` for each linked worktree. Saves a `git worktree list` for each of
 * the dozens of sibling repos a scan looks at. Says true whenever it cannot tell, so git decides.
 */
export async function mayHaveBranch(
  repoPath: string,
  branch: string,
): Promise<boolean> {
  const gitDir = path.join(repoPath, '.git');
  const want = `ref: refs/heads/${branch}`;
  const onBranch = async (headFile: string) =>
    (await fs.readFile(headFile, 'utf8')).trim() === want;
  try {
    // A `.git` file (a worktree or submodule as the repo) or anything unusual: let git answer.
    if (!(await fs.stat(gitDir)).isDirectory()) return true;
    if (await onBranch(path.join(gitDir, 'HEAD'))) return true;
    let names: string[];
    try {
      names = await fs.readdir(path.join(gitDir, 'worktrees'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
    for (const name of names)
      if (await onBranch(path.join(gitDir, 'worktrees', name, 'HEAD')))
        return true;
    return false;
  } catch {
    return true;
  }
}

/** Worktrees on `branch` in each repo, in the order of `repoPaths`; repos that fail are skipped. */
export async function scanBranch(
  git: GitClient,
  repoPaths: string[],
  branch: string,
): Promise<Candidate[]> {
  const perRepo: Candidate[][] = repoPaths.map(() => []);
  let next = 0;
  const worker = async () => {
    while (next < repoPaths.length) {
      const i = next++;
      const repoPath = repoPaths[i];
      try {
        if (!(await mayHaveBranch(repoPath, branch))) continue;
        for (const wt of await git.worktreeList(repoPath))
          if (wt.branch === branch)
            perRepo[i].push({
              repoPath,
              worktreePath: wt.path,
              branch,
              mainCheckout: samePath(wt.path, repoPath),
            });
      } catch {
        // missing or broken repo: skipped
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(SCAN_CONCURRENCY, repoPaths.length) },
      worker,
    ),
  );
  return perRepo.flat();
}

const realReaddir = async (dir: string): Promise<string[]> =>
  (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

const realIsRepo = (dir: string): Promise<boolean> =>
  pathExists(path.join(dir, '.git'));

/** Direct sibling folders of the given repos that contain `.git`, excluding the repos themselves and `*.worktrees` folders. */
export async function siblingRepos(
  repoPaths: string[],
  readdir: (dir: string) => Promise<string[]> = realReaddir,
  isRepo: (dir: string) => Promise<boolean> = realIsRepo,
): Promise<string[]> {
  const out: string[] = [];
  const parents = [
    ...new Set(repoPaths.map((r) => path.dirname(path.resolve(r)))),
  ];
  for (const parent of parents) {
    let names: string[];
    try {
      names = await readdir(parent);
    } catch {
      continue;
    }
    const dirs = names
      .filter((name) => !name.endsWith('.worktrees'))
      .map((name) => path.join(parent, name))
      .filter((dir) => !repoPaths.some((r) => samePath(r, dir)));
    const repos = await Promise.all(dirs.map((dir) => isRepo(dir)));
    dirs.forEach((dir, i) => {
      if (repos[i] && !out.some((o) => samePath(o, dir))) out.push(dir);
    });
  }
  return out;
}
