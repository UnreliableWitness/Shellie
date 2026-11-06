import path from 'node:path';
import { readJson } from '../fsRetry';
import { isRecord } from './sources/types';

/**
 * `shellie run`'s extra arguments go after the command's last line (`<cmd> "$@"` on macOS, `<cmd> @shellieArgs` on
 * Windows). They are refused, never escaped, where they would not stay arguments.
 */

/** Whether `line` holds a `#` outside quotes (a comment would swallow the arguments). */
function hasUnquotedHash(line: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === '\\') i++;
    else if (quote === '"') {
      if (c === '"') quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return true;
  }
  return false;
}

/** What `& | < > ^ % ! "` and line breaks would do in cmd.exe when a `.cmd` target re-parses the arguments. */
const CMD_META = /[&|<>^%!"\r\n]/;

/**
 * Why the arguments cannot go after `command` (null when they can): its last line ends in an operator, a redirect,
 * a line continuation or an opening bracket, or has a comment, so they would become a command or vanish; on Windows an
 * argument with cmd.exe metacharacters. The message names the command only, never an argument.
 */
export function argsRefusal(
  name: string,
  command: string,
  args: string[],
  platform: NodeJS.Platform,
): string | null {
  if (args.length === 0) return null;
  const last = command.trimEnd().split(/\r?\n/).at(-1)!.trim();
  if (/[;&|({\\<>]$/.test(last) || hasUnquotedHash(last))
    return `${name} takes no extra arguments in Shellie: its command line ends in an operator or comment`;
  if (platform === 'win32' && args.some((a) => CMD_META.test(a)))
    return 'On Windows an argument for shellie run cannot hold & | < > ^ % ! " or a line break';
  return null;
}

/** `npm test`, `npm run <x>` and the like: the package.json script a command runs (`test`, `x`), else null. */
export function packageScriptName(command: string): string | null {
  const line = command.trim();
  // Anything shell-like after it and the line is more than the script.
  if (/[;&|<>`$()\n]/.test(line)) return null;
  const m =
    /^npm\s+(?:test|t)(?:\s|$)/.exec(line) ??
    /^(?:npm\s+(?:run|run-script)|pnpm\s+run|yarn\s+run)\s+([^\s-]\S*)/.exec(
      line,
    );
  if (!m) return null;
  return m[1] ?? 'test';
}

/**
 * The arguments with `--` in front for an npm, pnpm or yarn script, so `shellie run test -- --watch` gives `--watch`
 * to the script, not to npm. Unchanged when the agent or the command line already has the `--`.
 */
export function withScriptSeparator(
  command: string | null,
  args: string[],
): string[] {
  if (!command || args.length === 0 || args[0] === '--') return args;
  if (packageScriptName(command) === null || /\s--(\s|$)/.test(command))
    return args;
  return ['--', ...args];
}

/**
 * The package.json scripts `command` runs, from the worktree (what really runs): `pre<x>`, `<x>` and `post<x>` in
 * order, those that exist. npm runs the pre and post scripts; pnpm and yarn may not, and showing them is the safe
 * side. Null when the command is no script or the script is missing (npm then runs nothing).
 */
export async function packageScripts(
  worktreePath: string,
  command: string,
): Promise<{ name: string; text: string }[] | null> {
  const name = packageScriptName(command);
  if (name === null) return null;
  try {
    const pkg = await readJson(path.join(worktreePath, 'package.json'));
    const scripts =
      isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts : undefined;
    if (!scripts) return null;
    const text = (n: string) => {
      const v = Object.hasOwn(scripts, n) ? scripts[n] : undefined;
      return typeof v === 'string' ? v : null;
    };
    if (text(name) === null) return null;
    return [`pre${name}`, name, `post${name}`].flatMap((n) => {
      const t = text(n);
      return t === null ? [] : [{ name: n, text: t }];
    });
  } catch {
    // No package.json, or not JSON.
    return null;
  }
}
