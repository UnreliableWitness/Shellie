import type { BrainAgent } from '../../../shared/brain';
import type { TerminalDef } from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import { track } from '../../telemetry';

export type BrainAction =
  | 'refresh'
  | 'lint'
  | 'digest'
  | 'ask'
  | 'drop'
  /** The dropped files sent in, with their types and notes. */
  | 'add'
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
  | 'close-terminal'
  /** Mark verified on a wiki page; a source removed; a value scrubbed. */
  | 'verify'
  | 'remove-source'
  | 'scrub'
  /** From a task's Finish: the lessons option ticked. */
  | 'lessons-option'
  /** Browsing: a page or source opened (card, hit, chip, link), a search ran, back or forward. */
  | 'open-page'
  | 'search'
  | 'back'
  /** The front page's Continue reading, back to the page last read. */
  | 'continue-reading'
  /** Run now: a sync; a `?` opened; an option switched in What runs by itself. */
  | 'sync'
  | 'help'
  | 'option'
  /** The Read or Add view chosen. */
  | 'view-read'
  | 'view-add'
  /** Pictures: a re-evaluation queued (source panel or Health), a drop accepted with Fine, I know. */
  | 'reevaluate'
  | 'accept-drop'
  /** The composer: rich text pasted as Markdown, then put back as plain text; Write/Split/Preview; a draft discarded. */
  | 'paste-markdown'
  | 'paste-plain'
  | 'editor-view'
  | 'discard'
  /** Settling conflicts: the view opened, a conflict parked, its question copied, an answer added, one skipped, a re-check. */
  | 'settle-open'
  | 'park'
  | 'copy-question'
  | 'answer'
  | 'skip'
  | 'recheck';

/** One click on the Brain page, counted without names or content. */
export const trackBrain = (action: BrainAction) =>
  track('brain.screen.action', { action });

type Notify = (level: 'error', message: string) => void;

/** Copies the linked DevOps wiki into the brain's sources and says what changed. */
export const refreshWiki = async (
  brainId: string,
  notify: (level: 'info' | 'error', message: string) => void,
) => {
  trackBrain('refresh');
  const r = await tryInvoke(
    () => api().invoke('brain:refresh', brainId),
    notify,
  );
  if (!r) return;
  if (r.ok)
    notify(
      'info',
      `Wiki refreshed: ${r.added} added, ${r.changed} changed, ${r.removed} removed`,
    );
  else notify('error', r.message);
};

/**
 * Starts (or resumes) the brain's terminal; the caller shows it. `prompt` is submitted to the agent by main: the first
 * message of a new process, or typed into the running one. `agent` opens it on another agent than the brain's.
 */
export const openBrainTerminal = (
  brainId: string,
  notify: Notify,
  resumeSession?: string | null,
  prompt?: string,
  agent?: BrainAgent,
): Promise<TerminalDef | undefined> =>
  tryInvoke(
    () =>
      agent
        ? api().invoke(
            'brain:terminal',
            brainId,
            resumeSession ?? null,
            prompt,
            agent,
          )
        : prompt
          ? api().invoke(
              'brain:terminal',
              brainId,
              resumeSession ?? null,
              prompt,
            )
          : resumeSession
            ? api().invoke('brain:terminal', brainId, resumeSession)
            : api().invoke('brain:terminal', brainId),
    notify,
  );

/** The composer's Add: what went in and on which model kind, as counts and flags only (never names, notes or text). */
export const trackBrainAdd = (p: {
  text: boolean;
  files: number;
  note: boolean;
  ownNotes: number;
  model: 'haiku' | 'sonnet' | 'opus' | 'opencode';
  overridden: boolean;
}) => track('brain.screen.action', { action: 'add', ...p });

/** A conflict settled: its kind, the choice, whether it was the agent's suggestion, and whether a why or an answer came with it. */
export const trackSettle = (p: {
  kind: 'contradiction' | 'scope-change';
  choice: string;
  suggested: boolean;
  why: boolean;
  answered: boolean;
}) => track('brain.screen.action', { action: 'settle', ...p });

/** Where the Settle view was opened from. */
export const trackSettleOpen = (from: 'add' | 'health' | 'read') =>
  track('brain.screen.action', { action: 'settle-open', from });
