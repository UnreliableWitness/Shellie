import type { PrFallbackReason } from '../../shared/prDraft';
import type { TabView } from '../attention/TabActivity';
import { QUIET_MS } from '../services/ClaudeRetheme';

/** A tab is asked only when its agent answered within this long: its prompt cache is then likely still warm. */
export const RECENT_MS = 60 * 60 * 1000;

export type TabCandidate = {
  id: string;
  label: string;
  kind: 'claude' | 'opencode';
  /** Its process runs (a tab can outlive it). */
  running: boolean;
  /** Paused after a Production value showed up: nothing may be typed into it. */
  paused: boolean;
  /** When the agent last said something in the tab's session (epoch ms); null when its session has no turns. */
  lastAgentTurnAt: number | null;
  activity: TabView | null;
};

export type Verdict = 'ok' | 'none' | 'stale' | 'busy' | 'typing';

/** Whether Shellie may type into the tab now, else what stops it; the one rule for picking a tab and for typing. */
export function tabVerdict(c: TabCandidate, now: number): Verdict {
  if (!c.running || c.paused || c.lastAgentTurnAt === null) return 'none';
  if (now - c.lastAgentTurnAt > RECENT_MS) return 'stale';
  const a = c.activity;
  if (!a) return 'busy';
  // No report since it (re)started is a resumed tab waiting at its prompt; Claude's `clear` means it exited.
  if (a.state !== null && a.state !== 'idle' && a.state !== 'done')
    return 'busy';
  if (a.typed) return 'typing';
  if (a.quietFor < QUIET_MS) return 'busy';
  return 'ok';
}

/**
 * The tab to ask for the PR description: a running, unpaused Claude Code or OpenCode tab whose agent answered in the
 * last hour, waits at an empty prompt and is quiet; the most recently active one when several qualify. Otherwise the
 * reason, the one that explains the most: unsent text, then busy, then not used lately, then no tab at all.
 */
export function pickTab(
  candidates: readonly TabCandidate[],
  now: number,
):
  | { tab: TabCandidate }
  | {
      reason: Extract<PrFallbackReason, 'no-tab' | 'busy' | 'stale' | 'typing'>;
    } {
  const verdicts = candidates.map((c) => ({ c, v: tabVerdict(c, now) }));
  const ok = verdicts
    .filter((x) => x.v === 'ok')
    .sort((a, b) => (b.c.lastAgentTurnAt ?? 0) - (a.c.lastAgentTurnAt ?? 0));
  if (ok.length > 0) return { tab: ok[0].c };
  const has = (v: Verdict) => verdicts.some((x) => x.v === v);
  if (has('typing')) return { reason: 'typing' };
  if (has('busy')) return { reason: 'busy' };
  if (has('stale')) return { reason: 'stale' };
  return { reason: 'no-tab' };
}

export type SendVerdict = 'ok' | 'none' | 'busy' | 'typing';

/**
 * Whether a line may be typed into the tab's prompt for the person to send (an answer from the brain): tabVerdict
 * without the one-hour rule and without needing an earlier agent turn, since nothing is asked of the session.
 */
export function sendVerdict(c: TabCandidate, now: number): SendVerdict {
  if (!c.running || c.paused) return 'none';
  const v = tabVerdict({ ...c, lastAgentTurnAt: now }, now);
  return v === 'stale' ? 'ok' : v;
}

/** The tab to type a line into: the one with the latest agent turn (none yet counts as oldest); else why none can take it. */
export function pickSendTab<T extends TabCandidate>(
  candidates: readonly T[],
  now: number,
): { tab: T } | { reason: Exclude<SendVerdict, 'ok'> } {
  const verdicts = candidates.map((c) => ({ c, v: sendVerdict(c, now) }));
  const ok = verdicts
    .filter((x) => x.v === 'ok')
    .sort((a, b) => (b.c.lastAgentTurnAt ?? 0) - (a.c.lastAgentTurnAt ?? 0));
  if (ok.length > 0) return { tab: ok[0].c };
  if (verdicts.some((x) => x.v === 'typing')) return { reason: 'typing' };
  if (verdicts.some((x) => x.v === 'busy')) return { reason: 'busy' };
  return { reason: 'none' };
}
