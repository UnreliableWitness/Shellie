import { randomUUID } from 'node:crypto';
import { brainTaskId, type Brain } from '../../shared/brain';
import type { TerminalDef } from '../../shared/types';
import type { Platform } from '../platform/Platform';
import type { TerminalManager } from '../services/TerminalManager';
import type { BrainStore } from './BrainStore';

/** The brain's one Claude terminal: the stored one, or the definition a first open will store. */
export function brainTerminalDef(brain: Brain): TerminalDef {
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
};

export function createBrainTerminals(d: BrainTerminalDeps) {
  const ownerOf = (terminalId: string): Brain | undefined =>
    d.brains.list().find((b) => b.terminal?.id === terminalId);

  const spawn = async (brain: Brain, def: TerminalDef, resume: boolean) => {
    const command = d.platform.claudeCommand(
      null,
      brainClaudeArgs(def, resume, d.sessionExists, d.themeFile()),
    );
    await d.terminals.spawn({
      id: def.id,
      taskId: brainTaskId(brain.id),
      cwd: brain.path,
      command: command.command,
      args: command.args,
      env: d.env(brain.id),
    });
  };

  return {
    async open(
      brainId: string,
      resumeSession?: string | null,
    ): Promise<TerminalDef> {
      const brain = d.brains.get(brainId);
      if (!brain) throw new Error(`Unknown brain ${brainId}`);
      const stored = brainTerminalDef(brain);
      if (brain.terminal && d.terminals.isRunning(stored.id)) return stored;
      const sessionId = resumeSession || stored.sessionId || randomUUID();
      const resume = Boolean(resumeSession || stored.sessionId);
      const def: TerminalDef = { ...stored, sessionId };
      await d.brains.patch(brainId, { terminal: def });
      await spawn(brain, def, resume);
      return def;
    },
    ownerOf,
    async restart(terminalId: string): Promise<boolean> {
      const brain = ownerOf(terminalId);
      if (!brain?.terminal) return false;
      if (d.terminals.isRunning(terminalId)) await d.terminals.kill(terminalId);
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
