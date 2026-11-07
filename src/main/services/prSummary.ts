import { spawn } from 'node:child_process';
import type { Command } from '../platform/Platform';

/**
 * The "what changed and why" of a draft pull request (#111), written at Finish by Claude Code in print mode from the
 * branch (commits with their bodies, diff stat and diff), the work item and what the developer asked their Claude
 * sessions. The Finish page shows it for editing; the PR description puts it above the commit list.
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
const REQUESTS_MAX = 8_000;
const REQUEST_MAX = 800;
const CUT = '\n[cut]';

export type PrSummaryContext = {
  /** e.g. "Bug 42: Fix it", or the task name. */
  heading: string;
  /** `git log` of the branch with commit bodies. */
  log: string;
  /** `git diff --stat` of the branch. */
  stat: string;
  /** The branch's diff (lock files left out). */
  diff: string;
  /** What the developer typed in the task's Claude Code sessions, oldest first. */
  requests: string[];
  /** The repo's PR_STYLE_FILE, when it has one. */
  style: string | null;
};

const cut = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, max - CUT.length) + CUT;

const INSTRUCTIONS = `You write the description of a pull request for its reviewers. You get the work item, what the developer asked their coding agent during the task, the commits and the diff. You may read files in the current folder (the branch's worktree) when the diff alone does not explain a change.

Write Markdown in this shape:
## What changed
2 to 6 bullets in plain words, grouped by behaviour or area, not file by file.
## Why
1 to 3 sentences: the problem or goal, taken from the work item, the requests and the commit bodies.
## How to review
Only when something needs a reviewer's attention (a risky spot, a migration, a manual step, a known gap); leave the section out otherwise.

Rules: at most ${PR_SUMMARY_MAX - 500} characters; no title line (the PR has its own); no commit list and no cost line (both are added below your text); do not mention AI, agents or this prompt; do not invent anything the material does not show; write in the language of the commits. Reply with the description only.`;

/** The prompt for Claude Code, within PR_PROMPT_MAX: the diff gets what the other parts leave. */
export function prSummaryPrompt(c: PrSummaryContext): string {
  const requests: string[] = [];
  let used = 0;
  for (const r of c.requests) {
    if (used + r.length > REQUESTS_MAX) break;
    requests.push(`- ${r.replace(/\n/g, '\n  ')}`);
    used += r.length;
  }
  const parts = [
    INSTRUCTIONS,
    ...(c.style?.trim()
      ? [
          `The repo's own style guide for descriptions (it wins over the shape above):\n${cut(c.style.trim(), STYLE_MAX)}`,
        ]
      : []),
    `# Work item\n${c.heading}`,
    `# What the developer asked\n${requests.length > 0 ? requests.join('\n') : '(none recorded)'}`,
    `# Commits\n${cut(c.log.trim(), LOG_MAX) || '(none)'}`,
    `# Files changed\n${cut(c.stat.trim(), STAT_MAX) || '(none)'}`,
  ];
  const fixed = parts.join('\n\n').length + '\n\n# Diff\n'.length;
  const diff = cut(c.diff.trim(), Math.max(0, PR_PROMPT_MAX - fixed));
  return `${parts.join('\n\n')}\n\n# Diff\n${diff}`;
}

type TranscriptLine = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: unknown };
};

/** Lines that are Claude Code's own (slash commands, shell escapes, reminders), not the developer's words. */
const MACHINE =
  /^<(command-|local-command-|bash-|system-reminder|task-notification)/;

/** What the developer typed in a Claude Code transcript (`.jsonl` lines), oldest first, each once. */
export function userRequests(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    let l: TranscriptLine;
    try {
      l = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    if (l.type !== 'user' || l.isMeta || l.isSidechain) continue;
    const content = l.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (p): p is { type: 'text'; text: string } =>
                  typeof p === 'object' &&
                  p !== null &&
                  (p as { type?: unknown }).type === 'text' &&
                  typeof (p as { text?: unknown }).text === 'string',
              )
              .map((p) => p.text)
              .join('\n')
          : '';
    const t = text.trim();
    if (!t || MACHINE.test(t) || t.startsWith('[Request interrupted')) continue;
    const short = t.length > REQUEST_MAX ? `${t.slice(0, REQUEST_MAX)}…` : t;
    if (!out.includes(short)) out.push(short);
  }
  return out;
}

/**
 * The flags for one print-mode run: JSON out, read-only tools, no MCP servers (their tool lists can be most of the
 * context), no saved session, a spending cap. Measured on a 48k-character prompt: about 23k tokens, 10 s, $0.10.
 */
export function prSummaryFlags(): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    'sonnet',
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

/**
 * Runs a command with `input` on stdin and resolves to its stdout. A non-zero exit rejects with the last line of
 * stderr; exit 127 (the login shell found no such program) says the program is missing; past `timeoutMs` the
 * process is killed.
 */
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
