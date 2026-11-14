import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Environment } from '../../shared/secrets';
import type { GitClient } from '../services/GitClient';
import type { LeakHit, LeakMatcher } from './LeakMatcher';
import { graverEnvironment } from './telemetry';

/** The gravest environment among hits, null for none. */
const gravest = (hits: LeakHit[]): Environment | null =>
  hits.reduce<Environment | null>((a, h) => graverEnvironment(a, h.env), null);

/** Untracked files bigger than this are not read for the Changes flag (the diff view does not show them either). */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/** A path as git prints it in a header: C-quoted when it has special characters (octal escapes are UTF-8 bytes). */
export function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    '\\': 92,
  };
  const s = p.slice(1, -1);
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = s[i + 1] ?? '';
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Reads a unified diff (made with `a/` and `b/` prefixes) line by line: `added` gets each added line with its path
 * on the new side, `fileEnd` is called before each new file's header.
 */
class DiffReader {
  private file: string | null = null;
  private inHunk = false;

  constructor(
    private readonly added: (file: string, line: string) => void,
    private readonly fileEnd: () => void = () => {},
  ) {}

  line(line: string): void {
    if (line.startsWith('diff --git ')) {
      this.fileEnd();
      this.file = null;
      this.inHunk = false;
    } else if (!this.inHunk && line.startsWith('+++ ')) {
      // git ends the name with a tab when it holds a space.
      const p = unquote(line.slice(4).replace(/\t$/, ''));
      this.file = p === '/dev/null' ? null : p.replace(/^b\//, '');
    } else if (line.startsWith('@@')) this.inHunk = true;
    else if (this.inHunk && this.file !== null && line.startsWith('+'))
      this.added(this.file, line.slice(1));
  }
}

/** The added lines of a unified diff (made with `a/` and `b/` prefixes), per path on the new side. */
export function parseAddedLines(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  const reader = new DiffReader((file, line) =>
    out.set(file, `${out.get(file) ?? ''}${line}\n`),
  );
  for (const line of diff.split('\n')) reader.line(line);
  return out;
}

/** The lines `refs` add (one range like `base...HEAD`, or a ref against the working tree), per path. */
async function addedLines(
  git: GitClient,
  worktree: string,
  refs: string[],
): Promise<Map<string, string>> {
  const diff = await git.run(worktree, [
    '--no-optional-locks',
    '-c',
    'core.quotepath=off',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '-U0',
    '-M',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...refs,
    '--',
  ]);
  return parseAddedLines(diff);
}

/**
 * The paths whose added lines hold a stored value, each with the gravest environment of the values it holds: lines
 * the diff adds, and whole files for the `untracked` paths (repo-relative, read from the worktree) the diff does
 * not list.
 */
export async function pathsWithLeaks(
  git: GitClient,
  worktree: string,
  refs: string[],
  matcher: LeakMatcher,
  untracked: string[] = [],
): Promise<Map<string, Environment>> {
  const found = new Map<string, Environment>();
  if (matcher.empty) return found;
  const add = (p: string, text: string) => {
    const env = gravest(matcher.find(text));
    if (env !== null) found.set(p, env);
  };
  const added = await addedLines(git, worktree, refs);
  for (const [p, text] of added) add(p, text);
  for (const p of untracked) {
    if (added.has(p)) continue;
    const full = path.join(worktree, p);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile() || st.size > MAX_UNTRACKED_BYTES) continue;
    add(p, await fs.readFile(full, 'utf8').catch(() => ''));
  }
  return found;
}

/** A file's added lines are scanned at the latest at this size, keeping the end so a value is not cut. */
const SCAN_AT = 4 * 1024 * 1024;
const KEEP = 64 * 1024;
/** A `git log` that has not answered by then is given up on: Finish treats it as an unchecked branch. */
const GIT_LOG_TIMEOUT_MS = 60_000;
/**
 * The line `--format=%x01%H` prints before each commit's diff. No diff line starts with it: they start with a
 * header word, `+`, `-`, a space or `\`.
 */
const COMMIT_MARK = '\x01';

export type DiffScan = {
  /** Whether a file's added text (a big file's in pieces of SCAN_AT, each after the last KEEP of the one before) hits. */
  match: (text: string) => boolean;
  /** Every file with a hit, in diff order; otherwise git is stopped at the first. */
  all?: boolean;
  /** Called on each commit's `\x01<sha>` line (from `--format=%x01%H`); false skips that commit's lines. */
  commit?: (sha: string) => boolean;
  /** None: no limit. */
  timeoutMs?: number;
  git?: string;
};

/**
 * The files whose added lines `match`, in the diff a git command prints (`args`, from the subcommand on, made with
 * `a/` and `b/` prefixes). Streamed, so a big diff does not hit a buffer limit. Rejects (without git's output) when
 * git fails, cannot start or does not finish within `timeoutMs`.
 */
export function diffStreamHits(
  worktree: string,
  args: string[],
  scan: DiffScan,
): Promise<string[]> {
  const name = `git ${args[0]}`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      scan.git ?? 'git',
      ['--no-optional-locks', '-c', 'core.quotepath=off', ...args],
      {
        cwd: worktree,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const hits: string[] = [];
    let stopped = false;
    let settled = false;
    const timer =
      scan.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(new Error(`${name} timed out`));
          }, scan.timeoutMs);
    timer?.unref?.();
    child.on('exit', () => clearTimeout(timer));
    let file: string | null = null;
    let text = '';
    let skip = false;
    const check = () => {
      if (!stopped && file !== null && text && scan.match(text)) {
        if (!hits.includes(file)) hits.push(file);
        if (!scan.all) {
          stopped = settled = true;
          clearTimeout(timer);
          child.kill();
          resolve(hits);
        }
      }
      text = '';
    };
    const reader = new DiffReader(
      (f, line) => {
        if (skip) return;
        file = f;
        text += `${line}\n`;
        if (text.length > SCAN_AT) {
          const tail = text.slice(-KEEP);
          check();
          text = tail;
        }
      },
      () => {
        check();
        file = null;
      },
    );
    const line = (l: string) => {
      if (!l.startsWith(COMMIT_MARK)) return reader.line(l);
      check();
      file = null;
      if (!stopped) skip = scan.commit?.(l.slice(1)) === false;
    };
    let rest = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const l of lines) {
        line(l);
        if (stopped) return;
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(`${name} could not start`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) return reject(new Error(`${name} failed (${code})`));
      line(rest);
      check();
      resolve(hits);
    });
  });
}

/**
 * Whether any commit a push would send (`base..HEAD`, merges left out) adds a stored value, also one a later
 * commit removed again: the push sends the history, not the net diff. `git log -p` is streamed, so a big branch
 * does not hit a buffer limit, and stops at the first file with a hit. Resolves with the gravest environment of
 * that file's hits (null for none). Rejects (without git's output) when git fails or does not finish within
 * `timeoutMs` (the push is then refused as unchecked, never let through).
 */
export async function branchLeaks(
  worktree: string,
  base: string,
  matcher: LeakMatcher,
  opts: { timeoutMs?: number; git?: string } = {},
): Promise<Environment | null> {
  if (matcher.empty) return null;
  let found: Environment | null = null;
  await diffStreamHits(
    worktree,
    [
      'log',
      '-p',
      '-U0',
      '--no-merges',
      '--format=',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      `${base}..HEAD`,
      '--',
    ],
    {
      match: (text) => {
        found = gravest(matcher.find(text));
        return found !== null;
      },
      timeoutMs: opts.timeoutMs ?? GIT_LOG_TIMEOUT_MS,
      git: opts.git,
    },
  );
  return found;
}
