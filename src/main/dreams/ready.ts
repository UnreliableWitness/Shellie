/**
 * Whether a dream may start now, and for which repo (spec section 2): a pure decision, so the scheduler only gathers
 * the facts. The waits are checked in the order of `Wait`; the first that holds is the answer.
 */

import type { DreamingSettings, DreamRepoState } from '../../shared/dreams';

export type Wait =
  | 'off'
  | 'model-missing'
  | 'active'
  | 'battery'
  | 'agents-busy'
  | 'running'
  | 'limit'
  | 'nothing-ready';

export type ReadyInput = {
  settings: DreamingSettings;
  /** OpenCode's model list; null when it is not known (OpenCode missing or failing). */
  models: string[] | null;
  idleSeconds: number;
  onBattery: boolean;
  agentWorking: boolean;
  running: boolean;
  overLimit: boolean;
  now: number;
  repos: {
    id: string;
    state: DreamRepoState;
    /** Some task of the repo has developer turns no dream covered yet. */
    hasMaterial: boolean;
    /** The time (ms) of the newest turn of that material; null without material. */
    newestMaterialAt: number | null;
  }[];
};

const HOUR_MS = 3600_000;
/** The wait after the first and the second failure in a row; after the third the repo stops. */
const BACKOFF_MS = [HOUR_MS, 6 * HOUR_MS];

/**
 * Until when a repo waits after failing: 1 h after the first failure, 6 h after the second, for good (`Infinity`)
 * after the third; null when it does not wait. Material newer than the last failure ends any wait.
 */
export function backoffUntil(
  state: DreamRepoState,
  newestMaterialAt: number | null,
): number | null {
  if (state.failures <= 0 || state.lastFailureAt === null) return null;
  const at = Date.parse(state.lastFailureAt);
  if (Number.isNaN(at)) return null;
  if (newestMaterialAt !== null && newestMaterialAt > at) return null;
  return state.failures > BACKOFF_MS.length
    ? Infinity
    : at + BACKOFF_MS[state.failures - 1];
}

const dreamtAt = (s: DreamRepoState): number =>
  s.lastDreamAt === null ? -Infinity : Date.parse(s.lastDreamAt);

/** `manual` (Dream now) skips the active, battery and agents-busy checks, and the back-off, only. */
export function nextDream(
  i: ReadyInput,
  manual?: { repoId: string },
): { repoId: string } | { wait: Wait } {
  const s = i.settings;
  if (!s.enabled) return { wait: 'off' };
  if (s.model === null || !i.models?.includes(s.model))
    return { wait: 'model-missing' };
  if (!manual) {
    if (i.idleSeconds < s.idleMinutes * 60) return { wait: 'active' };
    if (i.onBattery) return { wait: 'battery' };
    if (i.agentWorking) return { wait: 'agents-busy' };
  }
  if (i.running) return { wait: 'running' };
  if (i.overLimit) return { wait: 'limit' };

  const ready = i.repos.filter((r) => {
    const cfg = s.repos[r.id];
    if (!cfg?.on || cfg.folders.length === 0) return false;
    if (r.state.result !== null || !r.hasMaterial) return false;
    if (manual) return r.id === manual.repoId;
    const until = backoffUntil(r.state, r.newestMaterialAt);
    return until === null || i.now >= until;
  });
  if (ready.length === 0) return { wait: 'nothing-ready' };
  const first = ready.reduce((a, b) =>
    dreamtAt(b.state) < dreamtAt(a.state) ? b : a,
  );
  return { repoId: first.id };
}
