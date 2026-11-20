/**
 * What a dream proposal's commit changes, as git itself says (spec section 8): read-only plumbing from the repo's
 * own path, by commit (never the worktree, never files on disk), with no diff driver, text conversion or colour.
 * Everything returned is bounded: the text came from a model that read untrusted sessions.
 */

import type {
  DreamDiffHunk,
  DreamDiffLine,
  DreamFileDiff,
  DreamFileTexts,
} from '../../shared/dreams';
import type { GitClient } from '../services/GitClient';

type Git = Pick<GitClient, 'run'>;

/** Every git call that reads a dream's changes ends after this. */
export const DREAM_READ_TIMEOUT_MS = 15_000;
const MAX_FILES = 50;
/** A side larger than this gets no lines and no text. */
const MAX_SIDE = 500 * 1024;
const MAX_LINES = 400;
const MAX_LINE = 2000;
const MAX_ANSWER = 2 * 1024 * 1024;
/** Kept free of the answer's budget for the files that come back without lines. */
const RESERVE = 64 * 1024;

type Entry = {
  path: string;
  modes: [string, string];
  blobs: [string, string];
  /** Git's count; null for a binary file. */
  counts: { added: number; removed: number } | null;
};

/** Runs git from `repoPath` with `config` (hooks off) and the read timeout. */
const reader =
  (git: Git, repoPath: string, config: string[]) => (args: string[]) =>
    git.run(
      repoPath,
      [
        ...[...config, 'diff.suppressBlankEmpty=false'].flatMap((c) => [
          '-c',
          c,
        ]),
        ...args,
      ],
      { timeoutMs: DREAM_READ_TIMEOUT_MS },
    );

const absent = (blob: string) => /^0+$/.test(blob);

/** Every file `commit` changes against its parent, as git lists it (exact paths, no renames). */
async function changedFiles(
  run: (args: string[]) => Promise<string>,
  commit: string,
): Promise<Entry[]> {
  const tree = (format: string) =>
    run([
      'diff-tree',
      '-r',
      '-z',
      '--no-renames',
      '--no-commit-id',
      '--no-ext-diff',
      '--no-textconv',
      format,
      commit,
    ]);
  const counts = new Map<string, Entry['counts']>();
  for (const e of (await tree('--numstat')).split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(e);
    if (m)
      counts.set(
        m[3],
        m[1] === '-' ? null : { added: Number(m[1]), removed: Number(m[2]) },
      );
  }
  const raw = (await tree('--raw')).split('\0');
  const entries: Entry[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    // `:<mode> <mode> <sha> <sha> <status>`, then the path.
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) [A-Z]/.exec(raw[i]);
    if (!m) break;
    const path = raw[i + 1];
    entries.push({
      path,
      modes: [m[1], m[2]],
      blobs: [m[3], m[4]],
      // `null` (binary) is kept: only a path numstat did not list counts 0.
      counts: counts.has(path)
        ? (counts.get(path) ?? null)
        : { added: 0, removed: 0 },
    });
  }
  return entries;
}

/** A binary file, or a submodule's entry (a commit, not a blob). */
const isBinary = (e: Entry) => e.counts === null || e.modes.includes('160000');

async function tooLarge(
  run: (args: string[]) => Promise<string>,
  e: Entry,
): Promise<boolean> {
  for (const b of e.blobs)
    if (
      !absent(b) &&
      !(Number((await run(['cat-file', '-s', b])).trim()) <= MAX_SIDE)
    )
      return true;
  return false;
}

const cut = (s: string) => (s.length > MAX_LINE ? s.slice(0, MAX_LINE) : s);

/**
 * One file's unified diff (git's `-p` output) as hunks, with the added and removed lines counted over the whole
 * patch; at most `MAX_LINES` lines are kept (`truncated` when more), each cut at `MAX_LINE` characters.
 */
export function parsePatch(patch: string): {
  hunks: DreamDiffHunk[];
  added: number;
  removed: number;
  truncated: boolean;
  binary: boolean;
} {
  const hunks: DreamDiffHunk[] = [];
  let hunk: DreamDiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let shown = 0;
  let added = 0;
  let removed = 0;
  let truncated = false;
  let binary = false;
  for (const line of patch.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (head) {
      oldNo = Number(head[1]);
      newNo = Number(head[2]);
      hunk = { header: cut(line), lines: [] };
      if (shown < MAX_LINES) hunks.push(hunk);
      else truncated = true;
      continue;
    }
    if (!hunk) {
      // The file's header lines; a binary file has no hunks.
      if (line.startsWith('Binary files ') || line === 'GIT binary patch')
        binary = true;
      continue;
    }
    const text = cut(line.slice(1));
    let l: DreamDiffLine;
    if (line.startsWith(' '))
      l = { kind: 'context', text, oldNo: oldNo++, newNo: newNo++ };
    else if (line.startsWith('+')) {
      added++;
      l = { kind: 'add', text, oldNo: null, newNo: newNo++ };
    } else if (line.startsWith('-')) {
      removed++;
      l = { kind: 'del', text, oldNo: oldNo++, newNo: null };
    } else if (line.startsWith('\\'))
      l = { kind: 'note', text: cut(line.slice(2)), oldNo: null, newNo: null };
    else continue;
    if (shown < MAX_LINES) {
      hunk.lines.push(l);
      shown++;
    } else truncated = true;
  }
  return { hunks, added, removed, truncated, binary };
}

/**
 * The files of `commit` against its parent, at most `MAX_FILES`, each with git's hunks; past `MAX_ANSWER` in all
 * (or a side over `MAX_SIDE`) a file comes back without hunks and `tooLarge`, a binary one with `binary`.
 */
export async function proposalDiff(
  git: Git,
  repoPath: string,
  config: string[],
  commit: string,
): Promise<DreamFileDiff[]> {
  const run = reader(git, repoPath, config);
  const entries = (await changedFiles(run, commit)).slice(0, MAX_FILES);
  const files: DreamFileDiff[] = [];
  let budget = MAX_ANSWER - RESERVE;
  // One file after another: never a burst of git processes.
  for (const e of entries) {
    const base = {
      path: e.path,
      added: e.counts?.added ?? 0,
      removed: e.counts?.removed ?? 0,
      hunks: [],
    };
    if (isBinary(e)) {
      files.push({ ...base, binary: true });
      continue;
    }
    if (budget <= 0 || (await tooLarge(run, e))) {
      files.push({ ...base, tooLarge: true });
      continue;
    }
    const p = parsePatch(
      await run([
        '--literal-pathspecs',
        'diff-tree',
        '-r',
        '-p',
        '-U3',
        '--no-renames',
        '--no-commit-id',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        commit,
        '--',
        e.path,
      ]),
    );
    if (p.binary) {
      files.push({ ...base, binary: true });
      continue;
    }
    const file: DreamFileDiff = {
      path: e.path,
      added: p.added,
      removed: p.removed,
      hunks: p.hunks,
      ...(p.truncated ? { truncated: true } : {}),
    };
    const size = JSON.stringify(file).length;
    if (size > budget) {
      // From here on every file comes back without lines.
      budget = 0;
      files.push({
        ...base,
        added: p.added,
        removed: p.removed,
        tooLarge: true,
      });
      continue;
    }
    budget -= size;
    files.push(file);
  }
  return files;
}

/**
 * Both texts of `file`, one of the files `commit` changes, compared exactly as git lists them; null for any other
 * path. A binary file or a side over `MAX_SIDE` gives no text.
 */
export async function proposalFile(
  git: Git,
  repoPath: string,
  config: string[],
  commit: string,
  file: string,
): Promise<DreamFileTexts | null> {
  const run = reader(git, repoPath, config);
  const e = (await changedFiles(run, commit)).find((x) => x.path === file);
  if (!e) return null;
  if (isBinary(e)) return { binary: true };
  if (await tooLarge(run, e)) return { tooLarge: true };
  const text = (b: string) => (absent(b) ? '' : run(['cat-file', 'blob', b]));
  return { before: await text(e.blobs[0]), after: await text(e.blobs[1]) };
}
