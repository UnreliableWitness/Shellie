/** `env` is merged over the process environment by every caller that starts the command. */
export type Command = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export interface Platform {
  /** Short name shown on the shell tab, e.g. "zsh" or "PowerShell". */
  shellLabel: string;
  /** An interactive shell for a terminal tab. */
  interactiveShell(): Command;
  /**
   * Run one setup command line non-interactively, with the user's PATH loaded. Its output goes to pipes
   * (SetupRunner), and the exit code reports success.
   */
  shellCommand(cmd: string): Command;
  /**
   * Run one command line in a terminal (a pty, e.g. the dev server), with the user's PATH loaded. The
   * program keeps the console: no pipe in between, so colour, UTF-8 output and unbuffered logs survive.
   * `args` (`shellie run <name> -- args`) go after the command's last line as arguments, never through the shell
   * line: they reach the shell as data (argv, or an environment variable) and are expanded as one word each.
   */
  runCommand(cmd: string, args?: string[]): Command;
  /**
   * Run a task's setup command lines one after another in a terminal (the Setup tab), printing each before it runs
   * and stopping at the first one that fails.
   */
  setupCommands(cmds: string[]): Command;
  /** Copy a folder as a cheap copy-on-write clone; absent where the file system has none. `dest` must not exist. */
  cloneDir?(src: string, dest: string): Command;
  /**
   * Start Claude Code. `context` (the task) is appended to its system prompt, so Claude knows the task but waits
   * for the user's first message; null when resuming, as the session already has it. `flags` are Shellie's own
   * (session id, resume). `base` is the repo's own command line (the user's shell text, run as written, with the
   * flags after it); empty or absent means plain `claude`. `prompt` is the first message, sent as Claude's positional
   * prompt argument after everything else (Claude starts working on it).
   */
  claudeCommand(
    context: string | null,
    flags?: string[],
    base?: string,
    prompt?: string,
  ): Command;
  /**
   * Look for an agent CLI on the user's PATH: stdout is the executable's path on line 1 and `<name> --version`
   * on line 2; the exit code is non-zero when `name` is not found.
   */
  probeCommand(name: string): Command;
  /** Start GitHub Copilot CLI. */
  copilotCommand(): Command;
  /** Start OpenCode (no AI cost tracking); `base` is the repo's own command line, like for Claude. */
  opencodeCommand(base?: string): Command;
  /** Where .NET stores a project's user secrets (`secrets.json` inside); the folder may not exist; null when the home folder is unknown. */
  userSecretsDir(id: string): string | null;
  /**
   * Convert a picture file to PNG with the platform's own image tool (`src` and `dest` are absolute paths; `dest`
   * is written). Null when the platform has no tool for `src`'s format.
   */
  rasterizeCommand?(src: string, dest: string): Command | null;
  /** Open a folder in the editor. */
  editorCommand(path: string): Command;
  /** Open a file in the editor at a line (and column), in the worktree's window. */
  editorGotoCommand(
    worktree: string,
    file: string,
    line?: number,
    col?: number,
  ): Command;
}
