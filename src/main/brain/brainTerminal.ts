import { randomUUID } from 'node:crypto';
import { brainTaskId, type Brain, type BrainAgent } from '../../shared/brain';
import type { TerminalDef } from '../../shared/types';
import { sleep } from '../async';
import type { Wait } from '../fsRetry';
import type { Platform } from '../platform/Platform';
import type { TerminalManager } from '../services/TerminalManager';
import type { BrainStore } from './BrainStore';

/** The brain's one terminal on `agent` (default the brain's): the stored one when it runs that agent, else the definition an open will store. */
function brainTerminalDef(
  brain: Brain,
  agent: BrainAgent = brain.options.agent,
): TerminalDef {
  if (brain.terminal?.kind === agent) return brain.terminal;
  return { id: `brain-${brain.id}`, kind: agent, label: `${brain.name} brain` };
}

/** Resumes the stored session when it exists, else the latest one in the folder; a new terminal gets its session id. */
export function brainClaudeArgs(
  def: TerminalDef,
  resume: boolean,
  sessionExists: (id: string) => boolean,
  themeFile: string | null,
): string[] {
  const theme = themeFile ? ['--settings', themeFile] : [];
  if (resume && def.sessionId && sessionExists(def.sessionId))
    return ['--resume', def.sessionId, ...theme];
  if (resume && !def.sessionId) return ['--continue', ...theme];
  return ['--session-id', def.sessionId ?? randomUUID(), ...theme];
}

/** OpenCode resumes the stored session, else starts a new one (never `--continue`: jobs run in the same folder). */
export function brainOpencodeArgs(
  def: TerminalDef,
  model: string | null,
  prompt?: string,
): string[] {
  return [
    ...(def.sessionId ? ['--session', def.sessionId] : []),
    ...(model ? ['-m', model] : []),
    ...(prompt ? ['--prompt', prompt] : []),
  ];
}

export type BrainTerminalDeps = {
  brains: BrainStore;
  terminals: TerminalManager;
  platform: Platform;
  /** Telemetry and theme env for the brain's terminal (main). */
  env: (brainId: string) => Record<string, string>;
  themeFile: () => string | null;
  sessionExists: (id: string) => boolean;
  /** The newest OpenCode session in the brain folder since `since` that is not a job's (main). */
  opencodeSession: (brain: Brain, since: number) => string | null;
  now?: () => number;
  /** Between a message typed into a running terminal and its Enter (default 50 ms). */
  wait?: (ms: number) => Promise<void>;
};

/** How long a typed message settles in Claude's input box before Enter submits it. */
const SUBMIT_DELAY_MS = 50;

export function createBrainTerminals(d: BrainTerminalDeps) {
  const ownerOf = (terminalId: string): Brain | undefined =>
    d.brains.list().find((b) => b.terminal?.id === terminalId);

  const wait: Wait = d.wait ?? sleep;
  const now = d.now ?? Date.now;

  /**
   * An OpenCode terminal without a session id gets the one its last spawn made, stored; OpenCode makes the id
   * itself. Never spawned (no `spawnedAt`): nothing to find. A database that cannot be read finds nothing.
   */
  const withOpencodeSession = async (
    brain: Brain,
    def: TerminalDef,
  ): Promise<TerminalDef> => {
    if (def.kind !== 'opencode' || def.sessionId || def.spawnedAt === undefined)
      return def;
    let sessionId: string | null = null;
    try {
      sessionId = d.opencodeSession(brain, def.spawnedAt);
    } catch (e) {
      console.error('[brain] could not read OpenCode sessions', e);
    }
    if (!sessionId) return def;
    const found: TerminalDef = { ...def, sessionId };
    await d.brains.patch(brain.id, { terminal: found });
    return found;
  };

  /** `prompt` is the agent's first message: Claude's positional argument, OpenCode's `--prompt`. */
  const spawn = async (
    brain: Brain,
    def: TerminalDef,
    resume: boolean,
    prompt?: string,
  ) => {
    const command =
      def.kind === 'opencode'
        ? d.platform.opencodeCommand(
            undefined,
            brainOpencodeArgs(def, brain.options.opencodeModel, prompt),
          )
        : d.platform.claudeCommand(
            null,
            brainClaudeArgs(def, resume, d.sessionExists, d.themeFile()),
            undefined,
            prompt,
          );
    await d.terminals.spawn({
      id: def.id,
      taskId: brainTaskId(brain.id),
      cwd: brain.path,
      command: command.command,
      args: command.args,
      env: { ...d.env(brain.id), ...command.env },
    });
  };

  // An open in flight, so a double click or effect does not spawn twice.
  const opening = new Map<string, Promise<TerminalDef>>();

  /**
   * Shows the brain's terminal: a running one as it is (typing `prompt` and submitting it), unless another session is
   * asked for; else a new process (resuming `resumeSession`, or the stored session) with `prompt` as its first message.
   * `agent` (default the brain's) other than the running terminal's replaces it with one on that agent.
   */
  const open = async (
    brainId: string,
    resumeSession?: string | null,
    prompt?: string,
    agent?: BrainAgent,
  ): Promise<TerminalDef> => {
    const brain = d.brains.get(brainId);
    if (!brain) throw new Error(`Unknown brain ${brainId}`);
    // Continue names its session: nothing to look up.
    const wanted = brainTerminalDef(brain, agent);
    const stored = resumeSession
      ? wanted
      : await withOpencodeSession(brain, wanted);
    const otherSession = Boolean(
      resumeSession && resumeSession !== stored.sessionId,
    );
    if (
      brain.terminal?.kind === stored.kind &&
      d.terminals.isRunning(stored.id) &&
      !otherSession
    ) {
      if (prompt) {
        // xterm's Enter is \r; typed on its own after the text so Claude submits it rather than adding a line.
        d.terminals.write(stored.id, prompt);
        await wait(SUBMIT_DELAY_MS);
        d.terminals.write(stored.id, '\r');
      }
      return stored;
    }
    const resume = Boolean(resumeSession || stored.sessionId);
    let def: TerminalDef;
    if (stored.kind === 'opencode') {
      const sessionId = resumeSession || stored.sessionId;
      // A new session: its id is looked up after this spawn time on a later open.
      def = sessionId
        ? { ...stored, sessionId }
        : { ...stored, spawnedAt: now() };
    } else {
      const sessionId = resumeSession || stored.sessionId || randomUUID();
      def = { ...stored, sessionId };
    }
    await d.brains.patch(brainId, { terminal: def });
    // An exited process stays in the manager until it is killed; a running one on another session is replaced.
    if (d.terminals.has(def.id)) await d.terminals.kill(def.id);
    await spawn(brain, def, resume, prompt);
    return def;
  };

  return {
    open(
      brainId: string,
      resumeSession?: string | null,
      prompt?: string,
      agent?: BrainAgent,
    ) {
      const pending = opening.get(brainId);
      if (pending) return pending;
      const p = open(brainId, resumeSession, prompt, agent).finally(() =>
        opening.delete(brainId),
      );
      opening.set(brainId, p);
      return p;
    },
    ownerOf,
    async restart(terminalId: string): Promise<boolean> {
      const brain = ownerOf(terminalId);
      if (!brain?.terminal) return false;
      const def = await withOpencodeSession(brain, brain.terminal);
      if (d.terminals.has(terminalId)) await d.terminals.kill(terminalId);
      await spawn(brain, def, true);
      return true;
    },
    async kill(terminalId: string): Promise<boolean> {
      if (!ownerOf(terminalId)) return false;
      await d.terminals.kill(terminalId);
      return true;
    },
  };
}
