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
import { opencodeFailure, opencodeInput, type BrainJobDeps } from './jobs';
import { opencodeResultWithSession } from './opencodeResult';

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

/** `opencode run` for a question: the brain's ask command under a job's title, so the brain terminal never adopts the session. */
export function askOpencodeArgs(
  model: string | null,
  resume: string | null,
): string[] {
  const m = opencodeModelArg(model);
  return [
    'run',
    '--command',
    'ask',
    '--format',
    'json',
    '--title',
    `${BRAIN_JOB_TITLE}: ask`,
    ...(m ? ['-m', m] : []),
    ...(resume ? ['--session', resume] : []),
  ];
}

/** Stricter than the brain's own rules (which allow edits and five git commands): a question only reads. */
export function askOpencodePermission(): {
  edit: Record<string, 'deny'>;
  bash: Record<string, 'deny'>;
  webfetch: 'deny';
} {
  return { edit: { '*': 'deny' }, bash: { '*': 'deny' }, webfetch: 'deny' };
}

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
              input: opencodeInput('ask', askPrompt('claude', question)),
              env: {
                ...d.env(brainId),
                OPENCODE_CONFIG_CONTENT: JSON.stringify({
                  permission: askOpencodePermission(),
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
      return {
        ok: true,
        answer: {
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
