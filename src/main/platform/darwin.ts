import path from 'node:path';
import type { Command, Platform } from './Platform';
import { shellQuote } from './shellQuote';

/**
 * APFS clonefile(2) on a folder clones the whole tree in one call: about 1 s for 70 000 files, where `cp -cR`
 * clones file by file and takes as long as `npm ci` with a warm cache. JavaScript for Automation ships with macOS
 * and can call it; a failure (other volume, `dest` exists) exits non-zero.
 */
const CLONE_DIR = [
  'function run(argv) {',
  "  ObjC.bindFunction('clonefile', ['int', ['char *', 'char *', 'int']]);",
  "  if ($.clonefile(argv[0], argv[1], 0) !== 0) throw new Error('clonefile failed');",
  '}',
].join('\n');

export function darwinPlatform(env: NodeJS.ProcessEnv): Platform {
  const shell = env.SHELL && env.SHELL.length > 0 ? env.SHELL : '/bin/zsh';
  const login = (args: string[]): Command => ({
    command: shell,
    args: ['-l', ...args],
  });
  return {
    shellLabel: path.basename(shell),
    interactiveShell: () => login([]),
    shellCommand: (cmd) => login(['-c', cmd]),
    // "$@" holds the arguments, given to the shell as argv ($0 is `shellie`), so none is ever parsed as shell.
    runCommand: (cmd, args = []) =>
      args.length === 0
        ? login(['-c', cmd])
        : login(['-c', `${cmd} "$@"`, 'shellie', ...args]),
    setupCommands: (cmds) =>
      login([
        '-c',
        [
          'set -e',
          ...cmds.flatMap((c) => [`printf '%s\\n' ${shellQuote(`$ ${c}`)}`, c]),
        ].join('\n'),
      ]),
    cloneDir: (src, dest) => ({
      command: '/usr/bin/osascript',
      args: ['-l', 'JavaScript', '-e', CLONE_DIR, src, dest],
    }),
    // A repo's own command is the user's shell text, so it is not quoted; Shellie's flags are.
    claudeCommand: (context, flags = [], base) =>
      login([
        '-c',
        [
          `exec ${base?.trim() || 'claude'}`,
          ...[
            ...flags,
            ...(context === null ? [] : ['--append-system-prompt', context]),
          ].map(shellQuote),
        ].join(' '),
      ]),
    probeCommand: (name) =>
      login(['-c', `command -v ${name} && ${name} --version`]),
    copilotCommand: () => login(['-c', 'exec copilot']),
    opencodeCommand: (base) =>
      login(['-c', `exec ${base?.trim() || 'opencode'}`]),
    userSecretsDir: (id) =>
      env.HOME
        ? path.posix.join(env.HOME, '.microsoft', 'usersecrets', id)
        : null,
    editorCommand: (p) => ({ command: 'code', args: [p] }),
    editorGotoCommand: (wt, f, line, col) => ({
      command: 'code',
      args: [wt, '-g', `${f}:${line ?? 1}:${col ?? 1}`],
    }),
  };
}
