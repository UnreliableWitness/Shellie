/**
 * The dream events (spec section 9, `docs/telemetry.md`): enums, counts and booleans only. No model, repo, branch,
 * file name, path, title or any text of a dream ever goes in them.
 */

import type { DreamingSettings, DreamJournalEntry } from '../../shared/dreams';
import type { TelemetryProps } from '../../shared/telemetry';
import type { DreamOutcome } from './DreamRunner';

/** Sends one event; main passes the telemetry client's `event`. */
export type DreamEvent = (name: string, props: TelemetryProps) => void;

/**
 * Who switched dreaming off: the owner, a call answered by another model (in a dream or a re-test), a narrowing that
 * left nothing, or a re-test of the dreaming model that failed otherwise.
 */
export type SwitchedOffBy =
  | 'owner'
  | 'wrong-model'
  | 'narrowed'
  | 'test-failed';

/** `dream.enabled`: the kind of limit and how many repos dream. */
export function enabledProps(s: DreamingSettings): TelemetryProps {
  return {
    limit: s.limit?.kind ?? 'none',
    repos: Object.values(s.repos).filter((r) => r.on).length,
  };
}

/**
 * `dream.run`: the outcome as the journal words it (an interruption by the limit is `limit`), its duration, the
 * proposals it left and the ideas its own check removed. `entry` is the journal line the runner wrote for it, when
 * there is one (a dream that found no material writes none).
 */
export function runProps(
  out: DreamOutcome,
  entry: DreamJournalEntry | null,
  ms: number,
): TelemetryProps {
  const outcome =
    entry?.outcome ??
    (out.outcome === 'interrupted' && out.why === 'limit'
      ? 'limit'
      : out.outcome);
  return {
    outcome,
    ms: Math.max(0, Math.round(ms)),
    proposals:
      out.outcome === 'proposed'
        ? out.result.proposals.length
        : (entry?.proposals ?? 0),
    droppedByCheck:
      out.outcome === 'proposed'
        ? out.result.removedByCheck
        : (entry?.removedByCheck ?? 0),
  };
}

/** `dream.result`: how a result was closed. */
export function resultProps(
  kept: number,
  dropped: number,
  outcome: 'task' | 'discarded',
): TelemetryProps {
  return { kept, dropped, outcome };
}

/** Never lets telemetry fail a dream or a handler. */
export function sendSafely(
  event: DreamEvent | undefined,
  name: string,
  props: TelemetryProps,
): void {
  try {
    event?.(name, props);
  } catch {
    // telemetry must never break dreaming
  }
}
