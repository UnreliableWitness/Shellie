import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Command, Platform } from './Platform';

/** Makes a prompt safe to pass through a .cmd/.bat shim: no quotes or cmd.exe metacharacters. */
export function shimSafePrompt(s: string): string {
  return s
    .replaceAll('"', "'")
    .replace(/[&|<>^%]/g, '')
    .replace(/ {2,}/g, ' ');
}

/** PowerShell treats U+2018..U+201B like an ASCII single quote inside '...' strings, so double them too. */
const SINGLE_QUOTES = new RegExp(
  `['${[0x2018, 0x2019, 0x201a, 0x201b].map((c) => String.fromCharCode(c)).join('')}]`,
  'g',
);
export const psQuote = (s: string): string =>
  `'${s.replace(SINGLE_QUOTES, (q) => q + q)}'`;

/**
 * Runs a setup command line and turns its outcome into an exit code, the same on PowerShell 5.1 and 7.
 * Fails with the last native exit code, or with 1 when a cmdlet error or a missing command was reported.
 * Native stderr never fails the command: 5.1 wraps it in NativeCommandError records when output is
 * redirected, so those are passed through to stderr as text and not counted (no $ErrorActionPreference
 * = 'Stop', which would make them terminating). `$?` is not used: it stays true after `& { ... }` even
 * when an error was written inside. The command sits on its own lines so a trailing # comment is harmless.
 */
export const psSetupWrapper = (cmd: string): string =>
  [
    '$shellieFailed = $false',
    '& {',
    cmd,
    '} 2>&1 | ForEach-Object {',
    '  if ($_ -is [System.Management.Automation.ErrorRecord]) {',
    `    if ("$($_.FullyQualifiedErrorId)" -notlike 'NativeCommandError*') { $shellieFailed = $true }`,
    '    [Console]::Error.WriteLine("$_")',
    '  } else { $_ }',
    '}',
    'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
    'if ($shellieFailed) { exit 1 }',
  ].join('\n');

/**
 * Runs a command line in a pty (a `run` terminal such as the dev server) and passes on the last native
 * exit code. No pipe: the program writes straight to the console, so it sees a TTY, its UTF-8 output
 * is not decoded through the OEM code page and its logs are not block-buffered. In a real console
 * PowerShell 5.1 does not wrap native stderr in error records, so the setup wrapper is not needed here.
 * A `throw` still exits 1 under -Command. The command sits on its own lines (trailing # comments).
 */
export const psRunWrapper = (cmd: string): string =>
  ['& {', cmd, '}', 'if ($LASTEXITCODE) { exit $LASTEXITCODE }'].join('\n');

/** The start of every PowerShell command line Shellie builds. */
const BASE_ARGS = ['-NoLogo', '-ExecutionPolicy', 'Bypass'];

/** Windows: PowerShell 7 if installed, else Windows PowerShell 5.1. */
export function windowsPlatform(
  env: NodeJS.ProcessEnv,
  deps: {
    which: (name: string) => string | null;
    exists?: (p: string) => boolean;
  },
): Platform {
  const exists = deps.exists ?? existsSync;
  const shell = deps.which('pwsh') ?? 'powershell.exe';
  const ps = (command: string): Command => ({
    command: shell,
    args: [...BASE_ARGS, '-NoProfile', '-Command', command],
  });

  /**
   * VS Code's own Code.exe next to the `bin\code.cmd` on PATH, started directly (#73): no hidden
   * PowerShell and cmd.exe in between, and no ELECTRON_RUN_AS_NODE trip through its CLI script.
   */
  const vscode = (args: string[]): Command => {
    const shim = deps.which('code');
    if (!shim) throw new Error('VS Code (code) is not on PATH');
    const exe = path.win32.join(
      path.win32.dirname(path.win32.dirname(shim)),
      'Code.exe',
    );
    if (exists(exe)) return { command: exe, args };
    return ps(
      `& code ${args.map((a) => (a === '-g' ? a : psQuote(a))).join(' ')}`,
    );
  };

  /** Native .exe runs directly (node-pty quotes args for ConPTY); shims go through PowerShell. */
  const nonInteractive = (command: string): Command => ({
    command: shell,
    args: [...BASE_ARGS, '-NoProfile', '-NonInteractive', '-Command', command],
  });

  /**
   * `flags` are Shellie's own tokens (no user text), so they are quoted for PowerShell; a prompt goes through an env var.
   * `base` is a repo's own command line, the user's PowerShell text: it always runs through PowerShell, unquoted.
   */
  const tool = (
    name: string,
    flags: string[],
    promptEnv: string | null = null,
    base?: string,
    /** A positional argument after everything else (Claude's first message), passed like `promptEnv`. */
    positional: string | null = null,
  ): Command => {
    const own = base?.trim();
    const found = own ? null : deps.which(name);
    const texts = [promptEnv, positional];
    if (found && found.toLowerCase().endsWith('.exe'))
      return {
        command: found,
        args: [...flags, ...texts.filter((t) => t !== null)],
      };
    // Not on PATH, or an npm shim: the same command line either way, so a missing tool fails in PowerShell
    // with the flags it was given ("not recognized") instead of a bare name that drops them.
    const line = [`& ${own || name}`, ...flags.map(psQuote)];
    const env: Record<string, string> = {};
    if (promptEnv !== null) {
      line.push('$env:SHELLIE_CLAUDE_PROMPT');
      env.SHELLIE_CLAUDE_PROMPT = shimSafePrompt(promptEnv);
    }
    if (positional !== null) {
      line.push('$env:SHELLIE_CLAUDE_FIRST_MESSAGE');
      env.SHELLIE_CLAUDE_FIRST_MESSAGE = shimSafePrompt(positional);
    }
    return Object.keys(env).length
      ? { ...ps(line.join(' ')), env }
      : ps(line.join(' '));
  };

  return {
    shellLabel: 'PowerShell',
    interactiveShell: () => ({
      command: shell,
      args: [...BASE_ARGS],
    }),
    shellCommand: (cmd) => nonInteractive(psSetupWrapper(cmd)),
    // The arguments travel as JSON in an env var, read as data and splatted: never part of the command text.
    runCommand: (cmd, args = []) =>
      args.length === 0
        ? nonInteractive(psRunWrapper(cmd))
        : {
            ...nonInteractive(
              [
                '$shellieArgs = [string[]](ConvertFrom-Json $env:SHELLIE_RUN_ARGS)',
                psRunWrapper(`${cmd} @shellieArgs`),
              ].join('\n'),
            ),
            env: { SHELLIE_RUN_ARGS: JSON.stringify(args) },
          },
    setupCommands: (cmds) =>
      nonInteractive(
        cmds
          .map((c) =>
            [`Write-Host ${psQuote(`$ ${c}`)}`, psRunWrapper(c)].join('\n'),
          )
          .join('\n'),
      ),
    // The context is the value of the last flag, so it can travel in the env var like any prompt.
    claudeCommand: (context, flags = [], base, prompt) =>
      tool(
        'claude',
        context === null ? flags : [...flags, '--append-system-prompt'],
        context,
        base,
        prompt || null,
      ),
    probeCommand: (name) =>
      ps(`(Get-Command ${name} -ErrorAction Stop).Source; & ${name} --version`),
    copilotCommand: () => tool('copilot', []),
    opencodeCommand: (base) => tool('opencode', [], null, base),
    userSecretsDir: (id) => {
      const appData =
        env.APPDATA ??
        (env.USERPROFILE
          ? path.win32.join(env.USERPROFILE, 'AppData', 'Roaming')
          : null);
      return appData === null
        ? null
        : path.win32.join(appData, 'Microsoft', 'UserSecrets', id);
    },
    // System.Drawing reads EMF, WMF, TIFF and BMP (GDI+), on Windows PowerShell 5.1 and PowerShell 7 alike.
    rasterizeCommand: (src, dest) =>
      /\.(emf|wmf|tiff?|bmp)$/i.test(src)
        ? ps(
            [
              'Add-Type -AssemblyName System.Drawing',
              `$img = [System.Drawing.Image]::FromFile(${psQuote(src)})`,
              `$img.Save(${psQuote(dest)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
              '$img.Dispose()',
            ].join('\n'),
          )
        : null,
    editorCommand: (p) => vscode([p]),
    editorGotoCommand: (wt, f, line, col) =>
      vscode([wt, '-g', `${f}:${line ?? 1}:${col ?? 1}`]),
  };
}
