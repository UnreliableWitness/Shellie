/**
 * The Finish page's draft of a PR's "what changed and why" (#111), written by the task's own agent tab when it is idle
 * and recently active, else by a headless Claude Code or OpenCode run. Main owns the drafts; the page shows them.
 */

/** The title of Shellie's headless OpenCode run, so its session is left out of the task's own sessions. */
export const PR_JOB_TITLE = 'Shellie PR description';

/** The models the headless Claude Code writer may use (Settings › Agents and terminals). */
export const PR_SUMMARY_MODELS = ['sonnet', 'haiku'] as const;
export type PrSummaryModel = (typeof PR_SUMMARY_MODELS)[number];

export type PrDraftStatus =
  | 'asking-tab'
  | 'tab-blocked'
  | 'writing'
  | 'ready'
  | 'failed'
  | 'skipped';

/** Why the tab was not asked, or why asking it gave nothing. */
export type PrFallbackReason =
  | 'no-tab'
  | 'busy'
  | 'stale'
  | 'typing'
  | 'no-reply'
  | 'exited'
  | 'timeout';

export type PrDraft = {
  status: PrDraftStatus;
  /** Who wrote (or is writing) the text: the task's tab, or a headless run; null before either started. */
  source: 'tab' | 'headless' | null;
  /** The tab being asked or that wrote it. */
  tab: { id: string; label: string } | null;
  text: string;
  error: string | null;
  /** Why the text was written without the tab, in words; null when the tab wrote it or none was there to ask. */
  note: string | null;
};

/** A draft with nothing in it yet, `status` as given (writing by default). */
export const blankPrDraft = (
  status: PrDraftStatus = 'writing',
  error: string | null = null,
): PrDraft => ({
  status,
  source: null,
  tab: null,
  text: '',
  error,
  note: null,
});

/** Whether the draft is still being written (Finish waits for it). */
export const prDraftBusy = (d: PrDraft | undefined): boolean =>
  d?.status === 'asking-tab' ||
  d?.status === 'tab-blocked' ||
  d?.status === 'writing';

/** A fallback reason in words, for the note under the field. */
export const PR_FALLBACK_NOTE: Record<PrFallbackReason, string | null> = {
  'no-tab': null,
  busy: 'the agent tab was busy',
  stale: 'the agent tab was not used in the last hour',
  typing: 'the agent tab had unsent text',
  'no-reply': 'the agent tab did not answer with a description',
  exited: 'the agent tab closed',
  timeout: 'the agent tab took too long',
};
