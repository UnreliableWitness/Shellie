/**
 * The git steps of a dream (spec section 4): its id and branch, the paths its runs changed, and Shellie's own commits
 * on the dream branch. Git runs unattended here: no repo hook, no fsmonitor program and no signing prompt.
 */

import path from 'node:path';
import { pathExists, removeTree } from '../fsRetry';
import { GitError, type GitClient } from '../services/GitClient';

/** The author of Shellie's dream commits when the repo has none configured. */
export const FALLBACK_AUTHOR = {
  name: 'Shellie Dreams',
  email: 'dreams@shellie.invalid',
};

type Git = Pick<
  GitClient,
  'run' | 'branchExists' | 'worktreeRemove' | 'worktreePrune' | 'deleteBranch'
>;

/** `-c` settings for every git call in a dream that could start a program: hooks go to an empty folder, no signing. */
export const unattendedConfig = (emptyHooksDir: string): string[] => [
  `core.hooksPath=${emptyHooksDir}`,
  'core.fsmonitor=false',
  'commit.gpgsign=false',
];

const withConfig = (config: string[]): string[] =>
  config.flatMap((c) => ['-c', c]);

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local calendar date of `ms`, `YYYY-MM-DD`. */
export function dreamDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `<date>-<n>`, the first `n` for which neither the branch `dream/<id>` nor the folder `<repoDir>/<id>` exists. */
export async function nextDreamId(
  git: Git,
  repoPath: string,
  repoDir: string,
  ms: number,
): Promise<string> {
  const date = dreamDate(ms);
  for (let n = 1; ; n++) {
    const id = `${date}-${n}`;
    if (
      !(await git.branchExists(repoPath, `dream/${id}`)) &&
      !(await pathExists(path.join(repoDir, id)))
    )
      return id;
  }
}

/** Every path that differs from HEAD in the worktree, untracked files included: repo-relative, `/`, sorted. */
export async function changedPaths(
  git: Git,
  worktree: string,
  config: string[],
): Promise<string[]> {
  const out = await git.run(worktree, [
    ...withConfig(config),
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]);
  const paths = out
    .split('\0')
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3));
  return [...new Set(paths)].sort();
}

/** The author settings for a commit: none when the repo has an author, else Shellie's own. */
async function authorConfig(git: Git, worktree: string): Promise<string[]> {
  const get = (key: string) =>
    git.run(worktree, ['config', '--get', key]).then(
      (s) => s.trim(),
      () => '',
    );
  const [name, email] = await Promise.all([
    get('user.name'),
    get('user.email'),
  ]);
  return name && email
    ? []
    : [
        `user.name=${FALLBACK_AUTHOR.name}`,
        `user.email=${FALLBACK_AUTHOR.email}`,
      ];
}

/**
 * Commits exactly `files` (changed, added or deleted) with `subject` and `body`; returns the new commit's sha. Nothing
 * else is staged: the caller has reverted every other change.
 */
export async function commitFiles(
  git: Git,
  worktree: string,
  o: { files: string[]; subject: string; body: string; config: string[] },
): Promise<string> {
  const c = withConfig([...o.config, ...(await authorConfig(git, worktree))]);
  await git.run(worktree, [
    ...c,
    '--literal-pathspecs',
    'add',
    '--',
    ...o.files,
  ]);
  await git.run(worktree, [
    ...c,
    'commit',
    '-q',
    '--no-verify',
    '-m',
    o.subject,
    ...(o.body.trim() ? ['-m', o.body] : []),
  ]);
  return (await git.run(worktree, ['rev-parse', 'HEAD'])).trim();
}

/** `dream: <title>`, the title cut to 72 characters. */
export const commitSubject = (title: string): string =>
  `dream: ${title.length > 72 ? title.slice(0, 72) : title}`;

/**
 * Removes a dream's worktree, its folder (worktree, data, hooks) and its branch; also after a half-made worktree.
 * Best effort: git's own removal first, then what is left.
 */
export async function removeDream(
  git: Git,
  repoPath: string,
  o: { dir: string; worktree: string; branch: string },
): Promise<void> {
  await git.worktreeRemove(repoPath, o.worktree, true).catch(() => undefined);
  await removeTree(o.dir).catch(() => undefined);
  await git.worktreePrune(repoPath).catch(() => undefined);
  if (await git.branchExists(repoPath, o.branch))
    await git.deleteBranch(repoPath, o.branch).catch(() => undefined);
}

/** `git: <first line of git's own error>` for a git failure, null for anything else. */
export function gitReason(e: unknown): string | null {
  if (!(e instanceof GitError)) return null;
  const first = e.stderr.trim().split(/\r?\n/)[0]?.trim();
  return `git: ${first || 'failed'}`;
}
