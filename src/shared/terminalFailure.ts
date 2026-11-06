import type { TerminalDef } from './types';
import { isAgentKind } from './agents';
import { clip } from './text';

export type TerminalKind = TerminalDef['kind'];

/** Why an agent tab stopped: its program is missing, its config is invalid, it stopped right after starting, or it never started. */
export type TerminalFailureReason =
  | 'missing-cli'
  | 'invalid-config'
  | 'crashed'
  | 'spawn-failed';

/** What the exit bar of a failed agent tab says (#109). */
export type TerminalFailure = {
  reason: TerminalFailureReason;
  title: string;
  /** The program's own words (one line of its output), when there is one. */
  detail?: string;
  /** What to do about it. */
  hint: string;
  /** The config file the program refused (OpenCode). */
  file?: string;
  /** OpenCode can start again without the project's config (OPENCODE_DISABLE_PROJECT_CONFIG). */
  canSkipProjectConfig?: boolean;
};

/** A non-zero exit sooner than this after the start counts as a failed start. */
export const EARLY_EXIT_MS = 30_000;

type Agent = { name: string; command: string; install: string };

/** The tabs that run an agent CLI: the only ones whose exit is diagnosed (a shell or run tab exits as its commands say). */
const AGENTS: Partial<Record<TerminalKind, Agent>> = {
  claude: {
    name: 'Claude Code',
    command: 'claude',
    install:
      'Install Claude Code (https://docs.claude.com/en/docs/claude-code/setup) so `claude` runs in a terminal',
  },
  copilot: {
    name: 'Copilot CLI',
    command: 'copilot',
    install:
      'Install GitHub Copilot CLI (npm install -g @github/copilot) so `copilot` runs in a terminal',
  },
  opencode: {
    name: 'OpenCode',
    command: 'opencode',
    install:
      'Install OpenCode (https://opencode.ai, or npm install -g opencode-ai) so `opencode` runs in a terminal',
  },
};

export { isAgentKind };

const agentName = (kind: TerminalKind): string => AGENTS[kind]?.name ?? kind;

// eslint-disable-next-line no-control-regex -- terminal escape sequences are the point
const ANSI =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** The output as plain lines: escape sequences gone, carriage returns as line ends. */
const plainLines = (output: string): string[] =>
  output
    .slice(-8000)
    .replace(ANSI, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim());

/** zsh/bash's "command not found", PowerShell 5.1's and 7's "is not recognized as the/a name of a cmdlet", cmd.exe's. */
const notFound = (text: string, command: string): boolean =>
  new RegExp(
    `command not found:? ${command}\\b|\\b${command}: (?:command )?not found|'${command}' is not recognized as (?:the|a) name of a cmdlet|'${command}' is not recognized as an internal or external command`,
    'i',
  ).test(text);

/**
 * What went wrong when an agent tab's program exited, from its exit code, its output and how long it ran; null
 * when the exit needs no explanation (a normal quit, a late exit, a shell or run tab).
 */
export function diagnoseExit(o: {
  kind: TerminalKind;
  exitCode: number;
  output: string;
  runMs: number;
}): TerminalFailure | null {
  const agent = AGENTS[o.kind];
  if (!agent || o.exitCode === 0) return null;
  const lines = plainLines(o.output);
  const text = lines.join('\n');

  if (o.kind === 'opencode') {
    const at = lines.findIndex((l) => /Configuration is invalid at /.test(l));
    if (at >= 0) {
      const file = lines[at].replace(/^.*Configuration is invalid at /, '');
      const why = lines
        .slice(at + 1)
        .find((l) => l.length > 0)
        ?.replace(/^[↳>\s-]+/, '');
      const name = file.split(/[\\/]/).pop() ?? file;
      return {
        reason: 'invalid-config',
        title: 'OpenCode could not read its configuration',
        ...(why ? { detail: clip(why, 300) } : {}),
        file,
        hint: `Fix or remove ${name} (an agent file written for Claude Code lists its tools as text; OpenCode wants a map such as \`tools: { read: true }\`), then Restart. Or start OpenCode without the project's configuration.`,
        canSkipProjectConfig: true,
      };
    }
  }

  if (o.exitCode === 127 || notFound(text, agent.command))
    return {
      reason: 'missing-cli',
      title: `${agent.name} is not installed or not on PATH`,
      hint: `${agent.install}, then Restart.`,
    };

  if (o.runMs >= EARLY_EXIT_MS) return null;
  const last = [...lines].reverse().find((l) => l.length > 0);
  return {
    reason: 'crashed',
    title: `${agent.name} stopped right after it started (exit code ${o.exitCode})`,
    ...(last ? { detail: clip(last, 300) } : {}),
    hint: 'The output above says why. Fix the cause, then Restart.',
  };
}

/** The exit bar text for a program that could not be started at all (pty spawn failed). */
export function spawnFailure(
  kind: TerminalKind,
  message: string,
): TerminalFailure {
  const agent = AGENTS[kind];
  return {
    reason: 'spawn-failed',
    title: `${agentName(kind)} could not be started`,
    detail: clip(message, 300),
    hint: agent
      ? `${agent.install}, then Restart.`
      : 'Check that the program exists, then Restart.',
  };
}
