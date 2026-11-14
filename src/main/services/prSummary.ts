import { spawn } from 'node:child_process';
import { PR_JOB_TITLE, type PrSummaryModel } from '../../shared/prDraft';
import { clip } from '../../shared/text';
import type { Turn } from '../brain/sessionDigest';
import type { Command } from '../platform/Platform';

/**
 * The "what changed and why" of a draft pull request (#111), written at Finish. This module is the headless writer
 * (Claude Code in print mode, else OpenCode) used when the task's own agent tab cannot be asked (src/main/prDraft):
 * from the work item, what was said in the task's sessions, the commits and the diff. The Finish page shows it for
 * editing; the PR description puts it above the commit list.
 */

/** The written text's limit: room is left for the heading, the commits and the cost line under PR_DESCRIPTION_MAX. */
export const PR_SUMMARY_MAX = 2500;
/** The prompt's limit in characters (about 15k tokens): enough for a typical branch, cheap on any model. */
export const PR_PROMPT_MAX = 60_000;
export const PR_SUMMARY_TIMEOUT_MS = 120_000;
/** A repo's own instructions for the description (its "Shellie skill"), committed at its root (not under .shellie/, which Shellie keeps out of git). */
export const PR_STYLE_FILE = '.shellie-pr.md';
const STYLE_MAX = 4_000;
const LOG_MAX = 12_000;
const STAT_MAX = 6_000;
/** The work item text (task.md: description, acceptance criteria, repro steps, comments). */
export const WORK_ITEM_MAX = 6_000;
/** What was said in the task's sessions: newest turns first until this, each turn cut at TURN_CUT. */
export const TURNS_MAX = 14_000;
export const TURN_CUT = 1_200;
const CUT = '\n[cut]';

export type PrSummaryContext = {
  /** e.g. "Bug 42: Fix it", or the task name. */
  heading: string;
  /** The task's `.shellie/task.md` (the whole work item and its comments), null when there is none. */
  workItem: string | null;
  /** `git log` of the branch with commit bodies. */
  log: string;
  /** `git diff --stat` of the branch. */
  stat: string;
  /** The branch's diff (lock files left out). */
  diff: string;
  /** What the developer and the agents said in the task's sessions, oldest first, Shellie's own requests left out. */
  turns: readonly Turn[];
  /** The repo's PR_STYLE_FILE, when it has one. */
  style: string | null;
};

const cut = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max - CUT.length) + CUT;

/** The description's shape and rules: the headless prompt and the request to a tab both use them. */
export const PR_SHAPE = `Write Markdown in this shape:
## What changed
2 to 6 bullets in plain words, grouped by behaviour or area, not file by file.
## Why
1 to 3 sentences: the problem or goal, from the work item (its description and acceptance criteria), the session and the commit bodies.
## How it works
Only when the approach is not obvious from the bullets: the solution chosen, and what was tried or ruled out, in 2 to 4 sentences.
## How it was verified
Only when the session shows it: the tests or checks that ran and what they showed, and what was not verified.
## How to review
Only when something needs a reviewer's attention (a risky spot, a migration, a manual step, a known gap).

Rules: at most ${PR_SUMMARY_MAX - 500} characters; no title line (the PR has its own); no commit list and no cost line (both are added below your text); do not mention AI, agents or how this description was written; do not invent anything the material does not show; write in the language of the commits.`;

const INSTRUCTIONS = `You write the description of a pull request for its reviewers. You get the work item, what the developer and their coding agent said during the task (how the problem was solved and checked), the commits and the diff. You may read files in the current folder (the branch's worktree) when the material does not explain a change.

${PR_SHAPE} Reply with the description only.`;

/** The session's turns within TURNS_MAX: the newest kept first, shown oldest first. */
function turnsSection(turns: readonly Turn[]): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const who = t.who === 'Developer' ? 'Developer' : 'Agent';
    const line = `${who}: ${clip(t.text.trim(), TURN_CUT).replace(/\n/g, '\n  ')}`;
    if (used + line.length > TURNS_MAX) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length === 0) return '(none recorded)';
  const left = turns.length - kept.length;
  return [
    ...(left > 0 ? [`(${left} earlier turns left out)`] : []),
    ...kept.reverse(),
  ].join('\n');
}

/** The prompt for the headless writer, within PR_PROMPT_MAX: the diff gets what the other parts leave. */
export function prSummaryPrompt(c: PrSummaryContext): string {
  const parts = [
    INSTRUCTIONS,
    ...(c.style?.trim()
      ? [
          `The repo's own style guide for descriptions (it wins over the shape above):\n${cut(c.style.trim(), STYLE_MAX)}`,
        ]
      : []),
    `# Work item\n${c.heading}${c.workItem?.trim() ? `\n\n${cut(c.workItem.trim(), WORK_ITEM_MAX)}` : ''}`,
    `# What was done (the task's sessions)\n${turnsSection(c.turns)}`,
    `# Commits\n${cut(c.log.trim(), LOG_MAX) || '(none)'}`,
    `# Files changed\n${cut(c.stat.trim(), STAT_MAX) || '(none)'}`,
  ];
  const fixed = parts.join('\n\n').length + '\n\n# Diff\n'.length;
  const diff = cut(c.diff.trim(), Math.max(0, PR_PROMPT_MAX - fixed));
  return `${parts.join('\n\n')}\n\n# Diff\n${diff}`;
}

/** `opencode run` for the headless writer: json events, titled so the task's own sessions leave it out; the prompt goes on stdin. */
export function prOpencodeArgs(): string[] {
  return ['run', '--format', 'json', '--title', PR_JOB_TITLE];
}

/** The OpenCode writer only reads: editing, shell commands and fetching are denied in its inline config. */
export function prOpencodeEnv(
  base: Record<string, string> = {},
): Record<string, string> {
  return {
    ...base,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' },
    }),
  };
}

/**
 * The flags for one print-mode run: JSON out, read-only tools, no MCP servers (their tool lists can be most of the
 * context), no saved session, a spending cap. Measured on a 48k-character prompt: about 23k tokens, 10 s, $0.10.
 */
export function prSummaryFlags(model: PrSummaryModel = 'sonnet'): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--tools',
    'Read,Grep,Glob',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-budget-usd',
    '0.50',
  ];
}

/** Leaves the repo's and the user's CLAUDE.md out: the prompt has what the description needs. */
export const PR_SUMMARY_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
};

type ResultMessage = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  session_id?: unknown;
};

/** The text of `claude -p --output-format json`; throws when the run failed or the output is not that JSON. */
export function claudeResult(stdout: string): string {
  return claudeResultWithSession(stdout).result;
}

/** Like claudeResult, plus the run's session id (null when the JSON has none). */
export function claudeResultWithSession(stdout: string): {
  result: string;
  sessionId: string | null;
} {
  // A login shell's profile may print before Claude Code does: the JSON is the whole output or its last line.
  const lines = stdout.trim().split('\n');
  let parsed: unknown;
  for (const candidate of [stdout.trim(), lines[lines.length - 1]]) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      /* try the next */
    }
  }
  if (parsed === undefined) {
    const last = lines[lines.length - 1]?.trim();
    throw new Error(last ? last.slice(0, 200) : 'Claude Code printed nothing');
  }
  const msg = (
    Array.isArray(parsed)
      ? [...(parsed as ResultMessage[])]
          .reverse()
          .find((m) => m?.type === 'result')
      : parsed
  ) as ResultMessage | undefined;
  if (!msg || typeof msg.result !== 'string')
    throw new Error('Claude Code gave no result');
  if (msg.is_error || (msg.subtype && msg.subtype !== 'success'))
    throw new Error(
      `Claude Code stopped (${msg.subtype ?? 'error'})${msg.result ? `: ${msg.result.slice(0, 200)}` : ''}`,
    );
  return {
    result: msg.result,
    sessionId: typeof msg.session_id === 'string' ? msg.session_id : null,
  };
}

/** The written text as the PR gets it: no code fence around it, no title line, within PR_SUMMARY_MAX. */
export function tidySummary(text: string): string {
  let t = text.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence) t = fence[1].trim();
  t = t.replace(/^# [^\n]*\n+/, '').trim();
  if (t.length <= PR_SUMMARY_MAX) return t;
  const head = t.slice(0, PR_SUMMARY_MAX - 1);
  const nl = head.lastIndexOf('\n');
  return `${(nl > PR_SUMMARY_MAX / 2 ? head.slice(0, nl) : head).trimEnd()}…`;
}

/** A run that exited non-zero: the message as before, plus the exit code and what the program printed on stdout. */
export class ExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stdout: string,
  ) {
    super(message);
  }
}

/**
 * Runs a command with `input` on stdin and resolves to its stdout. A non-zero exit rejects with the last line of
 * stderr; exit 127 (the login shell found no such program) says the program is missing; past `timeoutMs` the
 * process is killed.
 */
export function runWithInput(
  { command, args, env }: Command,
  o: {
    cwd: string;
    input: string;
    timeoutMs: number;
    env?: Record<string, string>;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 4_000_000) out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut)
        return reject(
          new Error(`timed out after ${Math.round(o.timeoutMs / 1000)} s`),
        );
      if (code === 0) return resolve(out);
      if (code === 127)
        return reject(
          new ExitError('Claude Code (claude) was not found', code, out),
        );
      const last = err.trim().split('\n').pop()?.trim();
      reject(new ExitError(last || `exited with code ${code}`, code, out));
    });
    // A program that never reads stdin closes it early; that is not an error here.
    child.stdin.on('error', () => undefined);
    child.stdin.end(o.input);
  });
}
