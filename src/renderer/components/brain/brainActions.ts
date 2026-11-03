import type { TerminalDef } from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import { track } from '../../telemetry';

export type BrainAction =
  | 'refresh'
  | 'lint'
  | 'digest'
  | 'ask'
  | 'drop'
  | 'paste'
  | 'resolve'
  | 'resume'
  | 'retry'
  | 'continue'
  /** A source captured from the inbox's list. */
  | 'capture'
  /** From a task: the Brain tab opened, a brain terminal opened, the Finish option ticked. */
  | 'tab'
  | 'terminal'
  | 'capture-option'
  /** The Brain page's terminal closed (killed). */
  | 'close-terminal';

/** One click on the Brain page, counted without names or content. */
export const trackBrain = (action: BrainAction) =>
  track('brain.screen.action', { action });

type Notify = (level: 'error', message: string) => void;

/**
 * Starts (or resumes) the brain's terminal; the caller shows it. `prompt` is submitted to Claude by main: the first
 * message of a new process, or typed into the running one.
 */
export const openBrainTerminal = (
  brainId: string,
  notify: Notify,
  resumeSession?: string | null,
  prompt?: string,
): Promise<TerminalDef | undefined> =>
  tryInvoke(
    () =>
      prompt
        ? api().invoke('brain:terminal', brainId, resumeSession ?? null, prompt)
        : resumeSession
          ? api().invoke('brain:terminal', brainId, resumeSession)
          : api().invoke('brain:terminal', brainId),
    notify,
  );
