import { randomUUID } from 'node:crypto';
import { brainTaskId, type Brain } from '../../shared/brain';
import type { TerminalDef } from '../../shared/types';
import { sleep } from '../async';
import type { Wait } from '../fsRetry';
import type { Platform } from '../platform/Platform';
import type { TerminalManager } from '../services/TerminalManager';
import type { BrainStore } from './BrainStore';

/** The brain's one Claude terminal: the stored one, or the definition a first open will store. */
function brainTerminalDef(brain: Brain): TerminalDef {
  return (
    brain.terminal ?? {
      id: `brain-${brain.id}`,
      kind: 'claude',
      label: `${brain.name} brain`,
    }
  );
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

export type BrainTerminalDeps = {
  brains: BrainStore;
  terminals: TerminalManager;
  platform: Platform;
  /** Telemetry and theme env for the brain's terminal (main). */
  env: (brainId: string) => Record<string, string>;
  themeFile: () => string | null;
  sessionExists: (id: string) => boolean;
  /** Between a message typed into a running terminal and its Enter (default 50 ms). */
  wait?: (ms: number) => Promise<void>;
};

/** How long a typed message settles in Claude's input box before Enter submits it. */
const SUBMIT_DELAY_MS = 50;

export function createBrainTerminals(d: BrainTerminalDeps) {
  const ownerOf = (terminalId: string): Brain | undefined =>
    d.brains.list().find((b) => b.terminal?.id === terminalId);

  const wait: Wait = d.wait ?? sleep;

  /** `prompt` is Claude's first message, as its positional argument. */
  const spawn = async (
    brain: Brain,
    def: TerminalDef,
    resume: boolean,
    prompt?: string,
  ) => {
    const command = d.platform.claudeCommand(
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
   */
  const open = async (
    brainId: string,
    resumeSession?: string | null,
    prompt?: string,
  ): Promise<TerminalDef> => {
    const brain = d.brains.get(brainId);
    if (!brain) throw new Error(`Unknown brain ${brainId}`);
    const stored = brainTerminalDef(brain);
    const otherSession = Boolean(
      resumeSession && resumeSession !== stored.sessionId,
    );
    if (brain.terminal && d.terminals.isRunning(stored.id) && !otherSession) {
      if (prompt) {
        // xterm's Enter is \r; typed on its own after the text so Claude submits it rather than adding a line.
        d.terminals.write(stored.id, prompt);
        await wait(SUBMIT_DELAY_MS);
        d.terminals.write(stored.id, '\r');
      }
      return stored;
    }
    const sessionId = resumeSession || stored.sessionId || randomUUID();
    const resume = Boolean(resumeSession || stored.sessionId);
    const def: TerminalDef = { ...stored, sessionId };
    await d.brains.patch(brainId, { terminal: def });
    // An exited process stays in the manager until it is killed; a running one on another session is replaced.
    if (d.terminals.has(def.id)) await d.terminals.kill(def.id);
    await spawn(brain, def, resume, prompt);
    return def;
  };

  return {
    open(brainId: string, resumeSession?: string | null, prompt?: string) {
      const pending = opening.get(brainId);
      if (pending) return pending;
      const p = open(brainId, resumeSession, prompt).finally(() =>
        opening.delete(brainId),
      );
      opening.set(brainId, p);
      return p;
    },
    ownerOf,
    async restart(terminalId: string): Promise<boolean> {
      const brain = ownerOf(terminalId);
      if (!brain?.terminal) return false;
      if (d.terminals.has(terminalId)) await d.terminals.kill(terminalId);
      await spawn(brain, brain.terminal, true);
      return true;
    },
    async kill(terminalId: string): Promise<boolean> {
      if (!ownerOf(terminalId)) return false;
      await d.terminals.kill(terminalId);
      return true;
    },
  };
}
