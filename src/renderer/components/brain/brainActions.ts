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
  | 'continue';

/** One click on the Brain page, counted without names or content. */
export const trackBrain = (action: BrainAction) =>
  track('brain.screen.action', { action });

type Notify = (level: 'error', message: string) => void;

/** Starts (or resumes) the brain's terminal; the caller shows it. */
export const openBrainTerminal = (
  brainId: string,
  notify: Notify,
  resumeSession?: string | null,
): Promise<TerminalDef | undefined> =>
  tryInvoke(
    () =>
      resumeSession
        ? api().invoke('brain:terminal', brainId, resumeSession)
        : api().invoke('brain:terminal', brainId),
    notify,
  );
