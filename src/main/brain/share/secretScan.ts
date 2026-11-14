/**
 * The secrets gate of a shared brain (the shared-brains spec, "Check" and "Secrets on every push"): the whole tree at
 * share time, and the text each unsent commit adds before a push. Each is one streamed git command read by leakScan's
 * diff reader, so no output has to fit a buffer.
 */
import { EMPTY_TREE } from '../../review/reviewGit';
import { diffStreamHits } from '../../secrets/leakScan';
import { findSecrets } from '../secrets';

/** The git binary to run (tests pass one that fails). */
type ScanOpts = { git?: string };

const hasSecret = (text: string) => findSecrets(text).length > 0;

/** Only the lines each file adds, never an external diff or a textconv filter. */
const DIFF_ARGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '-U0',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

/** The repo-relative files of `commit`'s tree that hold a possible secret: every line, as added since the empty tree. */
export function treeSecretFiles(
  dir: string,
  commit: string,
  opts: ScanOpts = {},
): Promise<string[]> {
  // git leaves binary files out.
  return diffStreamHits(dir, ['diff', ...DIFF_ARGS, EMPTY_TREE, commit, '--'], {
    match: hasSecret,
    all: true,
    git: opts.git,
  });
}

/**
 * The first file a commit in `range` (a rev-list range) adds a possible secret to, or null. Each commit on its own: a
 * line a later commit took out still goes to the server in the earlier one. A merge adds nothing of its own here (its
 * local side was scanned in the commits it merged). Throws when a scan cannot run: the caller holds the push then.
 * Commits in `clean` are skipped, and each commit found clean is added to it.
 */
export async function unsentSecretFile(
  dir: string,
  range: string,
  clean?: Set<string>,
  opts: ScanOpts = {},
): Promise<string | null> {
  let current: string | null = null;
  const passed = () => {
    if (current !== null) clean?.add(current);
  };
  const [file] = await diffStreamHits(
    dir,
    [
      'log',
      '-p',
      '--reverse',
      '--no-merges',
      '--format=%x01%H',
      ...DIFF_ARGS,
      range,
      '--',
    ],
    {
      match: hasSecret,
      // Called once the commit before has been read through without a hit.
      commit: (sha) => {
        passed();
        current = clean?.has(sha) ? null : sha;
        return current !== null;
      },
      git: opts.git,
    },
  );
  if (file) return file;
  passed();
  return null;
}
