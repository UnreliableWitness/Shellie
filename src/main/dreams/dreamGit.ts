/**
 * The git steps of a dream (spec section 4): its id and branch, the paths its runs changed, and Shellie's own commits
 * on the dream branch. Git runs unattended here: no repo hook, no fsmonitor program and no signing prompt.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists, removeTree } from '../fsRetry';
import { dayKey } from '../../shared/budget';
import { configFlags, type GitClient } from '../services/GitClient';

/**
 * The setup test call's folders inside the dreams folder (`<dreamsDir>/.test-<random>/{wt,data}`): there the ledger
 * knows its usage as a dream's. Never a repo id; the startup sweep removes one a crash left.
 */
export const DREAM_TEST_PREFIX = '.test-';

/** The author of Shellie's dream commits when the repo has none configured. */
export const FALLBACK_AUTHOR = {
  name: 'Shellie Dreams',
  email: 'dreams@shellie.invalid',
};

type Git = Pick<
  GitClient,
  'run' | 'branchExists' | 'worktreeRemove' | 'worktreePrune'
>;

/** `-c` settings for every git call in a dream that could start a program: hooks go to an empty folder, no signing. */
export const unattendedConfig = (emptyHooksDir: string): string[] => [
  `core.hooksPath=${emptyHooksDir}`,
  'core.fsmonitor=false',
  'commit.gpgsign=false',
  // The dream worktree sits about 100 characters deep: without this, Windows git reports long files as deleted.
  'core.longpaths=true',
];

/** The local calendar date of `ms`, `YYYY-MM-DD`. */
export const dreamDate = (ms: number): string => dayKey(new Date(ms));

/**
 * `<date>-<n>`, the first `n` not in `taken` (the ids the journal names) for which neither the branch `dream/<id>` nor
 * the folder `<repoDir>/<id>` exists.
 */
export async function nextDreamId(
  git: Git,
  repoPath: string,
  repoDir: string,
  ms: number,
  taken: ReadonlySet<string> = new Set(),
): Promise<string> {
  const date = dreamDate(ms);
  for (let n = 1; ; n++) {
    const id = `${date}-${n}`;
    if (
      !taken.has(id) &&
      !(await git.branchExists(repoPath, `dream/${id}`)) &&
      !(await pathExists(path.join(repoDir, id)))
    )
      return id;
  }
}

/**
 * Every path that differs from HEAD in the worktree, untracked and ignored files included (an agent's write to an
 * ignored path is a change like any other): repo-relative, `/`, sorted.
 */
export async function changedPaths(
  git: Git,
  worktree: string,
  config: string[],
): Promise<string[]> {
  const out = await git.run(worktree, [
    ...configFlags(config),
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignored',
    '--no-renames',
  ]);
  const paths = out
    .split('\0')
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3));
  return [...new Set(paths)].sort();
}

/** `changes.diff` is cut to at most this many bytes. */
export const CHANGES_DIFF_MAX = 2 * 1024 * 1024;
/** The last line of a cut `changes.diff`. */
export const CHANGES_DIFF_CUT =
  '[Shellie: this diff was cut at 2 MB; the changes go on past this line.]';

/** Every git call of `writeChangesDiff` ends after this: hashing a large repo's changes takes longer than a read. */
export const CHANGES_DIFF_TIMEOUT_MS = 120_000;

/**
 * Writes git's own diff of the worktree against `base` to `file` for `paths`, the changed paths as `changedPaths`
 * lists them (changed, added and deleted, untracked and ignored ones included: what the check run sees is all that
 * can be committed). Only those paths are added, literally and with `-f`, to a temporary index at `index` (removed
 * afterwards with its lock), so the worktree's own index stays as it was and no other file is rehashed; no external
 * diff, text conversion or colour. Each git call ends after `CHANGES_DIFF_TIMEOUT_MS`. Over `CHANGES_DIFF_MAX` bytes
 * the file is cut at a line end and ends with `CHANGES_DIFF_CUT`.
 */
export async function writeChangesDiff(
  git: Git,
  worktree: string,
  o: {
    base: string;
    file: string;
    index: string;
    config: string[];
    paths: string[];
  },
): Promise<void> {
  const c = configFlags(o.config);
  const opts = {
    env: { GIT_INDEX_FILE: o.index },
    timeoutMs: CHANGES_DIFF_TIMEOUT_MS,
  };
  const list = `${o.index}.paths`;
  try {
    await git.run(worktree, [...c, 'read-tree', o.base], opts);
    if (o.paths.length > 0) {
      // From a file, NUL-separated: no command line grows with the number of paths.
      await fs.writeFile(list, o.paths.map((p) => `${p}\0`).join(''));
      await git.run(
        worktree,
        [
          ...c,
          '--literal-pathspecs',
          'add',
          '-f',
          `--pathspec-from-file=${list}`,
          '--pathspec-file-nul',
        ],
        opts,
      );
    }
    await git.run(
      worktree,
      [
        ...c,
        'diff',
        '--cached',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        `--output=${o.file}`,
        o.base,
      ],
      opts,
    );
  } finally {
    await fs.rm(o.index, { force: true });
    await fs.rm(`${o.index}.lock`, { force: true });
    await fs.rm(list, { force: true });
  }
  const { size } = await fs.stat(o.file);
  if (size <= CHANGES_DIFF_MAX) return;
  const note = Buffer.from(`\n${CHANGES_DIFF_CUT}\n`);
  const keep = CHANGES_DIFF_MAX - note.length;
  const handle = await fs.open(o.file, 'r+');
  try {
    const head = Buffer.alloc(keep);
    await handle.read(head, 0, keep, 0);
    const lastLine = head.lastIndexOf(0x0a);
    const end = lastLine < 0 ? 0 : lastLine;
    await handle.truncate(end);
    await handle.write(note, 0, note.length, end);
  } finally {
    await handle.close();
  }
}

/** What each changed path holds now: a hash of its content (a symlink's target), `-` when it is gone. */
export async function snapshot(
  worktree: string,
  paths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of paths) {
    const abs = path.join(worktree, p);
    const st = await fs.lstat(abs).catch(() => null);
    const content = !st
      ? null
      : st.isSymbolicLink()
        ? Buffer.from(`link:${await fs.readlink(abs)}`)
        : st.isFile()
          ? await fs.readFile(abs)
          : Buffer.from('other');
    out.set(
      p,
      content === null
        ? '-'
        : createHash('sha256').update(content).digest('hex'),
    );
  }
  return out;
}

export const sameSnapshot = (
  a: Map<string, string>,
  b: Map<string, string>,
): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** The author settings for a commit: none when the repo has an author, else Shellie's own. */
export async function authorConfig(
  git: Git,
  worktree: string,
  config: string[],
): Promise<string[]> {
  const get = (key: string) =>
    git.run(worktree, [...configFlags(config), 'config', '--get', key]).then(
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
 * Commits exactly `files` (changed, added, deleted, or ignored and named on purpose) with `subject` and `body`;
 * returns the new commit's sha. Nothing else is staged: the caller has reverted every other change.
 */
export async function commitFiles(
  git: Git,
  worktree: string,
  o: { files: string[]; subject: string; body: string; config: string[] },
): Promise<string> {
  const c = configFlags([
    ...o.config,
    ...(await authorConfig(git, worktree, o.config)),
  ]);
  await git.run(worktree, [
    ...c,
    '--literal-pathspecs',
    'add',
    '-f',
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
  return (await git.run(worktree, [...c, 'rev-parse', 'HEAD'])).trim();
}

/** The body of every dream commit. */
export const COMMIT_BODY =
  'Proposed by a Shellie dream. Review before merging.';

/**
 * A proposal's commit made again with what the worktree now holds at `paths` (a path that is gone is removed): the
 * new commit's parent is `commit`'s parent and its tree is `commit`'s tree with those paths as they now are, so
 * nothing else of the worktree goes in. Built in a temporary index at `index` (removed afterwards) with
 * `commit-tree`: the worktree, its index and its branch stay as they were, and the new commit is on no branch (the
 * caller keeps it reachable). `same` when the paths hold what the commit already has, `empty` when the new commit
 * would change nothing against its parent.
 */
export async function remadeCommit(
  git: Git,
  worktree: string,
  o: {
    commit: string;
    paths: string[];
    index: string;
    subject: string;
    body: string;
    config: string[];
  },
): Promise<{ commit: string; files: string[] } | 'same' | 'empty'> {
  const c = configFlags([
    ...o.config,
    ...(await authorConfig(git, worktree, o.config)),
  ]);
  const opts = {
    env: { GIT_INDEX_FILE: o.index },
    timeoutMs: CHANGES_DIFF_TIMEOUT_MS,
  };
  const sha = async (rev: string) =>
    (await git.run(worktree, [...c, 'rev-parse', '--verify', rev])).trim();
  const list = `${o.index}.paths`;
  try {
    const parent = await sha(`${o.commit}^`);
    await git.run(worktree, [...c, 'read-tree', o.commit], opts);
    const present: string[] = [];
    const gone: string[] = [];
    for (const p of o.paths)
      ((await fs.lstat(path.join(worktree, p)).catch(() => null))
        ? present
        : gone
      ).push(p);
    for (const [paths, args] of [
      [present, ['add', '-f']],
      [gone, ['rm', '-q', '-r', '--cached', '--ignore-unmatch']],
    ] as const) {
      if (paths.length === 0) continue;
      // From a file, NUL-separated: no command line grows with the number of paths.
      await fs.writeFile(list, paths.map((p) => `${p}\0`).join(''));
      await git.run(
        worktree,
        [
          ...c,
          '--literal-pathspecs',
          ...args,
          `--pathspec-from-file=${list}`,
          '--pathspec-file-nul',
        ],
        opts,
      );
    }
    const tree = (await git.run(worktree, [...c, 'write-tree'], opts)).trim();
    if (tree === (await sha(`${o.commit}^{tree}`))) return 'same';
    if (tree === (await sha(`${parent}^{tree}`))) return 'empty';
    const commit = (
      await git.run(worktree, [
        ...c,
        'commit-tree',
        tree,
        '-p',
        parent,
        '-m',
        o.subject,
        ...(o.body.trim() ? ['-m', o.body] : []),
      ])
    ).trim();
    const files = (
      await git.run(worktree, [
        ...c,
        'diff-tree',
        '-r',
        '-z',
        '--no-renames',
        '--no-commit-id',
        '--name-only',
        commit,
      ])
    )
      .split('\0')
      .filter((f) => f !== '');
    return { commit, files };
  } finally {
    await fs.rm(o.index, { force: true });
    await fs.rm(`${o.index}.lock`, { force: true });
    await fs.rm(list, { force: true });
  }
}

/** Where the commits a dream's proposals had are kept reachable while the dream is open: one ref per commit. */
const keptRefs = (dreamId: string): string => `refs/shellie/dreams/${dreamId}/`;

/**
 * Keeps `commits` of the dream reachable (no gc removes them, no branch shows them): a ref each, in the repo. An
 * asked-for change replaces a proposal's commit, and Undo and the diff still read the ones of before.
 */
export async function keepCommits(
  git: Git,
  repoPath: string,
  dreamId: string,
  commits: string[],
  config: string[],
): Promise<void> {
  for (const sha of commits)
    await git.run(repoPath, [
      ...configFlags(config),
      'update-ref',
      `${keptRefs(dreamId)}${sha}`,
      sha,
    ]);
}

/** Removes the refs of `keepCommits`: the dream closed. Throws when git fails. */
export async function forgetCommits(
  git: Git,
  repoPath: string,
  dreamId: string,
  config: string[],
): Promise<void> {
  const c = configFlags(config);
  const refs = (
    await git.run(repoPath, [
      ...c,
      'for-each-ref',
      '--format=%(refname)',
      keptRefs(dreamId),
    ])
  )
    .split('\n')
    .filter((r) => r.startsWith(keptRefs(dreamId)));
  for (const ref of refs)
    await git.run(repoPath, [...c, 'update-ref', '-d', ref]);
}

const SUBJECT_MAX = 72;
const PREFIX = 'dream: ';

/**
 * `dream: <title>`, at most 72 characters in all: line breaks and control characters become single spaces, a longer
 * title is cut with an ellipsis, never inside a surrogate pair.
 */
export function commitSubject(title: string): string {
  const clean = title.replace(
    // eslint-disable-next-line no-control-regex -- control characters are what is replaced
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g,
    ' ',
  );
  const full = PREFIX + clean;
  if (full.length <= SUBJECT_MAX) return full;
  let cut = full.slice(0, SUBJECT_MAX - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** What a dream made itself, and so may remove; null for what it did not make (or found already there). */
export type DreamMade = {
  dir: string | null;
  worktree: string | null;
  branch: string | null;
};

/**
 * Removes what the dream made: its worktree (git's own removal first), its folder (worktree, data, hooks) and its
 * branch (with `config`, `unattendedConfig`); also after a half-made worktree. Never anything it did not make. Best
 * effort; the first failure is returned. When the repo's folder is gone from disk, removing the dream's folder is all
 * there is to do: git has nothing to prune or delete there.
 */
export async function removeDream(
  git: Git,
  repoPath: string,
  made: DreamMade,
  config: string[],
): Promise<unknown> {
  let failure: unknown = null;
  const step = (p: Promise<unknown>) =>
    p.catch((e: unknown) => {
      failure ??= e;
    });
  if (!(await pathExists(repoPath))) {
    if (made.dir) await step(removeTree(made.dir));
    return failure;
  }
  if (made.worktree)
    await git
      .worktreeRemove(repoPath, made.worktree, true)
      .catch(() => undefined);
  if (made.dir) await step(removeTree(made.dir));
  if (made.worktree) await step(git.worktreePrune(repoPath));
  if (made.branch && (await git.branchExists(repoPath, made.branch)))
    await step(
      git.run(repoPath, [...configFlags(config), 'branch', '-D', made.branch]),
    );
  return failure;
}
