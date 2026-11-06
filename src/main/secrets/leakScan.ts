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
function unquote(p: string): string {
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
      const p = unquote(line.slice(4));
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
 * Whether any commit a push would send (`base..HEAD`, merges left out) adds a stored value, also one a later
 * commit removed again: the push sends the history, not the net diff. `git log -p` is streamed, so a big branch
 * does not hit a buffer limit, and stops at the first file with a hit. Resolves with the gravest environment of
 * that file's hits (null for none). Rejects (without git's output) when git fails or does not finish within
 * `timeoutMs` (the push is then refused as unchecked, never let through).
 */
export function branchLeaks(
  worktree: string,
  base: string,
  matcher: LeakMatcher,
  opts: { timeoutMs?: number; git?: string } = {},
): Promise<Environment | null> {
  if (matcher.empty) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const child = spawn(
      opts.git ?? 'git',
      [
        '--no-optional-locks',
        '-c',
        'core.quotepath=off',
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
        cwd: worktree,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let found: Environment | null = null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('git log timed out'));
    }, opts.timeoutMs ?? GIT_LOG_TIMEOUT_MS);
    timer.unref?.();
    child.on('exit', () => clearTimeout(timer));
    let text = '';
    let rest = '';
    const scan = () => {
      const env = !found && text ? gravest(matcher.find(text)) : null;
      if (env !== null) {
        found = env;
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(env);
      }
      text = '';
    };
    const reader = new DiffReader((_file, line) => {
      text += `${line}\n`;
      if (text.length > SCAN_AT) {
        const tail = text.slice(-KEEP);
        scan();
        text = tail;
      }
    }, scan);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (found) return;
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        reader.line(line);
        if (found) return;
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error('git log could not start'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) return reject(new Error(`git log failed (${code})`));
      reader.line(rest);
      scan();
      resolve(found);
    });
  });
}
