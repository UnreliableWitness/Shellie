import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  askPrompt,
  BRAIN_JOB_TITLE,
  opencodeModelArg,
  type BrainModel,
} from '../../shared/brain';
import {
  ASK_CAP_MESSAGE,
  ASK_STOPPED,
  ASK_TIMEOUT_MS,
  type AskOutcome,
} from '../../shared/brainAsk';
import { claudeResultWithSession, programMissing } from '../services/prSummary';
import { opencodeFailure, type BrainJobDeps } from './jobs';
import { opencodeResultWithSession } from './opencodeResult';
import { brainOpencodePermission } from './templates';

/** The only tools an ask run has on Claude Code: it can read the brain and nothing else. */
const ASK_TOOLS = 'Read,Glob,Grep';

/**
 * Claude Code's flags for a question: headless, the answer as JSON, and only the reading tools, so the run cannot
 * write, edit or run a command whatever the skill or a page says. `resume` continues that session (a follow-up).
 */
export function askClaudeFlags(
  model: BrainModel,
  resume: string | null,
): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--tools',
    ASK_TOOLS,
    '--strict-mcp-config',
    ...(resume ? ['--resume', resume] : []),
  ];
}

/**
 * `opencode run` for a question: a plain message under a job's title (so the brain terminal never adopts the
 * session). Never `--command ask`: OpenCode puts a command's argument through its template, where !`…` in the
 * question or the work item's title runs in the shell and `@path` attaches a file, whatever the permissions say
 * (seen on 1.19.3). A plain message is only text.
 */
export function askOpencodeArgs(
  model: string | null,
  resume: string | null,
): string[] {
  const m = opencodeModelArg(model);
  return [
    'run',
    '--format',
    'json',
    '--title',
    `${BRAIN_JOB_TITLE}: ask`,
    ...(m ? ['-m', m] : []),
    ...(resume ? ['--session', resume] : []),
  ];
}

export type RulePatterns = { edit: string[]; bash: string[] };

/**
 * A question's rules on OpenCode: nothing is edited, no command runs, and the tools that reach outside the brain
 * (web, subagents) are taken away. OpenCode merges this with every other config it loads, where a rule for a
 * narrower pattern (`git status*`: allow) wins over `*`, so every pattern those rules name is denied by name too:
 * Shellie's own (brainOpencodePermission) and `own`, the ones found in the configs (opencodeRulePatterns).
 * Verified on OpenCode 1.19.3: with `*` alone `git status` still ran; `tools: false` changes nothing.
 */
export function askOpencodePermission(
  own: RulePatterns = { edit: [], bash: [] },
): {
  edit: Record<string, 'deny'>;
  bash: Record<string, 'deny'>;
  webfetch: 'deny';
  websearch: 'deny';
  codesearch: 'deny';
  task: 'deny';
} {
  const brain = brainOpencodePermission();
  const denied = (patterns: string[]): Record<string, 'deny'> =>
    Object.fromEntries(['*', ...patterns].map((p) => [p, 'deny' as const]));
  return {
    edit: denied([...Object.keys(brain.edit), ...own.edit]),
    bash: denied([...Object.keys(brain.bash), ...own.bash]),
    webfetch: 'deny',
    websearch: 'deny',
    codesearch: 'deny',
    task: 'deny',
  };
}

/** Every config file an OpenCode run in the brain's folder loads: the brain's own, then the person's. */
export function opencodeConfigFiles(
  brainDir: string,
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string[] {
  const global = path.join(
    env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'opencode',
  );
  return [
    path.join(brainDir, 'opencode.json'),
    path.join(brainDir, 'opencode.jsonc'),
    path.join(brainDir, '.opencode', 'opencode.json'),
    path.join(brainDir, '.opencode', 'opencode.jsonc'),
    path.join(global, 'opencode.json'),
    path.join(global, 'opencode.jsonc'),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
  ];
}

/** JSON as OpenCode accepts it: comments and trailing commas are taken out, text inside strings is kept. */
function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++)
        if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * The edit and bash patterns that the given OpenCode configs have rules for, their agents' rules included; a
 * missing file has none. A file that is there but cannot be read throws: a question must not run on rules Shellie
 * could not see.
 */
export async function opencodeRulePatterns(
  files: string[],
): Promise<RulePatterns> {
  const edit = new Set<string>();
  const bash = new Set<string>();
  const take = (permission: unknown) => {
    if (!permission || typeof permission !== 'object') return;
    const p = permission as { edit?: unknown; bash?: unknown };
    if (p.edit && typeof p.edit === 'object')
      for (const k of Object.keys(p.edit)) edit.add(k);
    if (p.bash && typeof p.bash === 'object')
      for (const k of Object.keys(p.bash)) bash.add(k);
  };
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw unreadable(file);
    }
    let config: unknown;
    try {
      config = parseJsonc(text);
    } catch {
      throw unreadable(file);
    }
    if (!config || typeof config !== 'object') continue;
    const c = config as { permission?: unknown; agent?: unknown };
    take(c.permission);
    if (c.agent && typeof c.agent === 'object')
      for (const a of Object.values(c.agent))
        take((a as { permission?: unknown } | null)?.permission);
  }
  return { edit: [...edit], bash: [...bash] };
}

const unreadable = (file: string) =>
  new Error(
    `Shellie could not read ${file}, so it cannot make sure a question only reads. Fix the file, or ask in the brain's terminal.`,
  );

export type BrainAsksDeps = Pick<
  BrainJobDeps,
  | 'platform'
  | 'run'
  | 'env'
  | 'tokensToday'
  | 'cap'
  | 'brainDir'
  | 'model'
  | 'agent'
  | 'opencodeModel'
  | 'ready'
> & {
  now: () => number;
  /** Why the brain's jobs are held, in words for the person. */
  heldReason: (brainId: string) => string;
  /** What the run cost, from the ledger; null while it has no record of it. */
  costOf: (
    brainId: string,
    sessionId: string | null,
    since: number,
  ) => number | null;
  /** The patterns the OpenCode configs of a run in the folder name (opencodeRulePatterns); tests pass their own. */
  rulePatterns?: (brainDir: string) => Promise<RulePatterns>;
  /** The folder's state (its commit and uncommitted changes) as one string, to tell whether a question left it as it was. */
  snapshot: (brainDir: string) => Promise<string>;
};

/**
 * Questions asked from a task's Brain tab: a headless, read-only run of the brain's agent in the brain's folder.
 * Outside the job queue and without the brain's lock (it only reads), so a question never waits behind a capture.
 * One run per asker (`key`, the task's id).
 */
export class BrainAsks {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly deps: BrainAsksDeps) {}

  async ask(
    key: string,
    brainId: string,
    question: string,
    resume: string | null,
  ): Promise<AskOutcome> {
    const d = this.deps;
    if (this.running.has(key)) throw new Error('A question is already running');
    if (!d.ready(brainId))
      return { ok: false, refused: 'held', message: d.heldReason(brainId) };
    if (d.tokensToday(brainId) >= d.cap(brainId))
      return { ok: false, refused: 'cap', message: ASK_CAP_MESSAGE };
    const stop = new AbortController();
    this.running.set(key, stop);
    const since = d.now();
    const opencode = d.agent(brainId) === 'opencode';
    try {
      const cwd = d.brainDir(brainId);
      // Read before anything runs: an OpenCode question never starts on rules Shellie could not see.
      const own = opencode
        ? await (
            d.rulePatterns ??
            ((dir: string) => opencodeRulePatterns(opencodeConfigFiles(dir)))
          )(cwd)
        : null;
      const before = await d.snapshot(cwd).catch(() => null);
      // Stop pressed while the rules and the folder were read: nothing is started.
      if (stop.signal.aborted) throw new Error('stopped');
      const o = { cwd, timeoutMs: ASK_TIMEOUT_MS, signal: stop.signal };
      let found: { result: string; sessionId: string | null };
      if (opencode) {
        const stdout = await d
          .run(
            d.platform.opencodeCommand(
              undefined,
              askOpencodeArgs(d.opencodeModel(brainId), resume),
            ),
            {
              ...o,
              input: askPrompt('opencode', question),
              env: {
                ...d.env(brainId),
                OPENCODE_CONFIG_CONTENT: JSON.stringify({
                  permission: askOpencodePermission(own ?? undefined),
                }),
              },
            },
          )
          .catch((e: unknown) => {
            if (stop.signal.aborted) throw e;
            throw opencodeFailure(e);
          });
        found = opencodeResultWithSession(stdout);
      } else {
        const stdout = await d.run(
          d.platform.claudeCommand(
            null,
            askClaudeFlags(d.model(brainId), resume),
          ),
          { ...o, input: askPrompt('claude', question), env: d.env(brainId) },
        );
        found = claudeResultWithSession(stdout);
      }
      let costEur: number | null = null;
      try {
        costEur = d.costOf(brainId, found.sessionId, since);
      } catch {
        costEur = null;
      }
      const after = await d.snapshot(cwd).catch(() => null);
      return {
        ok: true,
        answer: {
          changed: before === null || after !== before,
          sessionId: found.sessionId,
          answer: found.result,
          durationMs: d.now() - since,
          costEur,
        },
      };
    } catch (e) {
      if (stop.signal.aborted)
        return { ok: false, refused: null, message: ASK_STOPPED };
      if (!opencode && programMissing(e))
        return {
          ok: false,
          refused: null,
          message: 'Claude Code was not found',
        };
      return { ok: false, refused: null, message: (e as Error).message };
    } finally {
      this.running.delete(key);
    }
  }

  /** Stops the asker's running question; nothing when none runs. */
  stop(key: string): void {
    this.running.get(key)?.abort();
  }
}
