/**
 * The subjects of the commits Shellie makes in a brain, in one place: the merge of a shared brain reads them back to
 * tell job output (run again after a clash) from person-free commits and outside edits.
 */
import {
  BRAIN_JOB_KINDS,
  SOURCE_JOB_KINDS,
  type BrainJob,
  type BrainJobKind,
} from '../../shared/brain';

export const CREATED_MESSAGE = 'Brain created';
export const INDEX_MESSAGE = 'Brain: index';
export const SCRUB_MESSAGE = 'Brain: scrub';
export const VERIFIED_PREFIX = 'Brain: verified ';
export const MERGE_MESSAGE = 'Brain: merge from colleagues';
export const SHARED_FACTS_MESSAGE = 'Brain: shared facts';
export const KEEPER_MESSAGE = 'Brain: keeper';
export const JOIN_MESSAGE = 'Brain: joined';
export const SHARE_MESSAGE = 'Brain: shared';
export const LEAVE_MESSAGE = 'Brain: left';
export const SQUASH_MESSAGE = 'Brain: changes since the last send';

/** A job named by its commit subject: its kind, source, and a write's target or a settle's conflict id (`target`). */
export type JobRef = {
  kind: BrainJobKind;
  source: string | null;
  /** A write job's target, or a settle job's conflict id (`BrainJob.conflict`). */
  target: string | null;
};

/** A write's target or a settle's conflict id, as a JobRef's `target`; null for every other kind. */
export const jobTarget = (
  j: Pick<BrainJob, 'kind' | 'target' | 'conflict'>,
): string | null =>
  j.kind === 'write'
    ? (j.target ?? null)
    : j.kind === 'settle'
      ? (j.conflict ?? null)
      : null;

/** What a job's commit subject names after its kind: a write's target, a settle's conflict id, another job's source. */
export const jobArg = (
  j: Pick<BrainJob, 'kind' | 'source' | 'target' | 'conflict'>,
): string | null =>
  j.kind === 'write' || j.kind === 'settle' ? jobTarget(j) : j.source;

/** The options that queue a job with a JobRef's `target` again: a write's `target`, a settle's `conflict`. */
export const jobTargetOpts = (
  kind: BrainJobKind,
  target: string | null,
): { target?: string; conflict?: string } =>
  !target
    ? {}
    : kind === 'write'
      ? { target }
      : kind === 'settle'
        ? { conflict: target }
        : {};

/** `Brain: <kind>[ <source, target or conflict id>]`; parseJobSubject reads it back. */
export const jobSubject = (
  j: Pick<BrainJob, 'kind' | 'source' | 'target' | 'conflict'>,
): string => {
  const arg = jobArg(j);
  return `Brain: ${j.kind}${arg ? ` ${arg}` : ''}`;
};

const JOB_KINDS: ReadonlySet<string> = new Set(BRAIN_JOB_KINDS);

/**
 * The job a commit subject came from (`jobSubject`), or null for any other commit: an outside edit, `Brain: index`,
 * `Brain: settle conflict` (the Settle view's own commit).
 */
export function parseJobSubject(subject: string): JobRef | null {
  const m = /^Brain: ([a-z]+)(?: (.+))?$/.exec(subject.trim());
  if (!m || !JOB_KINDS.has(m[1])) return null;
  const kind = m[1] as BrainJobKind;
  const rest = m[2] ?? null;
  if (rest === null) return { kind, source: null, target: null };
  if (kind === 'write') return { kind, source: null, target: rest };
  if (kind === 'settle')
    return rest === 'conflict' ? null : { kind, source: null, target: rest };
  if (SOURCE_JOB_KINDS.has(kind) && rest.startsWith('sources/'))
    return { kind, source: rest, target: null };
  return null;
}

/**
 * Shellie commits with no person's text in them (the index, a verified stamp, merges, the share files): a clash on
 * their page loses nothing. Any other commit that is not a job's counts as an outside edit, the fold
 * (SQUASH_MESSAGE) and SCRUB_MESSAGE included.
 */
const PERSON_FREE: ReadonlySet<string> = new Set([
  CREATED_MESSAGE,
  INDEX_MESSAGE,
  MERGE_MESSAGE,
  SHARED_FACTS_MESSAGE,
  KEEPER_MESSAGE,
  JOIN_MESSAGE,
  SHARE_MESSAGE,
]);
export const isPersonFree = (subject: string) =>
  PERSON_FREE.has(subject.trim()) || subject.startsWith(VERIFIED_PREFIX);
