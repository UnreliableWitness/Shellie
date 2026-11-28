/** What an ask's agent is doing, as main tells the renderer while the run is under way (`ask:progress`). */

/** One thing the agent did, in words. Never raw tool output, never the agent's thinking. */
export type AskStep = {
  kind: 'read' | 'search' | 'edit' | 'write' | 'other';
  label: string;
};

/** How many steps of a run are kept; older ones are only counted. */
export const ASK_STEPS_MAX = 40;

export type AskProgress = {
  /** The newest steps, oldest first, at most `ASK_STEPS_MAX`. */
  steps: AskStep[];
  /** How many steps came before the ones kept. */
  earlier: number;
  /** The answer as far as it has been written; empty when the agent does not say. */
  text: string;
};

export const NO_PROGRESS: AskProgress = { steps: [], earlier: 0, text: '' };

/** The key of a task's question to its brain, and of a dream's ask, in `ask:progress`. */
export const brainAskKey = (taskId: string) => `brain:${taskId}`;
export const dreamAskKey = (repoId: string) => `dream:${repoId}`;
