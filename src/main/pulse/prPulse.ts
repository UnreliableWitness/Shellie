import type { CiState, PrPulse, ReviewState } from '../../shared/pulse';
import type {
  RawPolicyEvaluation,
  RawPrDetail,
  RawPrStatus,
  RawPrThread,
} from '../services/AdoClient';

/** The PR that belongs to this task: an active one, else the newest completed or abandoned one opened or closed since the task was opened. */
export function pickPr(
  prs: RawPrDetail[],
  openedAt: string | null,
): RawPrDetail | null {
  const active = prs.find((p) => p.status === 'active');
  if (active) return active;
  const since = openedAt === null ? null : Date.parse(openedAt);
  const stamp = (p: RawPrDetail) =>
    Date.parse(p.closedDate ?? p.creationDate) || 0;
  const live = prs.filter(
    (p) =>
      since === null ||
      p.status !== 'completed' ||
      p.closedDate === null ||
      Date.parse(p.closedDate) >= since,
  );
  return live.sort((a, b) => stamp(b) - stamp(a))[0] ?? null;
}

const FAILED_STATES = new Set(['failed', 'error']);

function ciOf(
  evaluations: RawPolicyEvaluation[],
  statuses: RawPrStatus[],
): { ci: CiState; ciFailedName: string | null } {
  let failed: string | null = null;
  let isFailing = false;
  let running = false;
  let seen = false;
  for (const e of evaluations) {
    if (e.typeName !== 'Build') continue;
    seen = true;
    if (e.status === 'rejected' || e.status === 'broken') {
      if (!isFailing) failed = e.displayName;
      isFailing = true;
    } else if (e.status === 'queued' || e.status === 'running') running = true;
  }
  const latest = new Map<string, RawPrStatus>();
  for (const s of statuses) {
    const cur = latest.get(s.context);
    if (!cur || s.creationDate > cur.creationDate) latest.set(s.context, s);
  }
  for (const s of latest.values()) {
    seen = true;
    if (FAILED_STATES.has(s.state)) {
      if (!isFailing) failed = s.context;
      isFailing = true;
    } else if (s.state === 'pending') running = true;
  }
  if (isFailing) return { ci: 'failing', ciFailedName: failed };
  if (running) return { ci: 'running', ciFailedName: null };
  return { ci: seen ? 'passing' : 'none', ciFailedName: null };
}

function unansweredOf(threads: RawPrThread[], pr: RawPrDetail, me: string) {
  let n = 0;
  for (const t of threads) {
    if (t.isDeleted || t.status !== 'active') continue;
    const last = t.comments
      .filter((c) => !c.isDeleted && c.commentType !== 'system')
      .at(-1);
    if (last && last.authorId !== me && last.authorId !== pr.createdById) n++;
  }
  return n;
}

export function toPrPulse(input: {
  workspaceId: string;
  pr: RawPrDetail | null;
  evaluations: RawPolicyEvaluation[];
  statuses: RawPrStatus[];
  threads: RawPrThread[];
  me: string;
  now: Date;
}): PrPulse {
  const { workspaceId, pr, evaluations, statuses, threads, me, now } = input;
  const checkedAt = now.toISOString();
  if (!pr)
    return {
      workspaceId,
      pr: null,
      ci: 'none',
      ciFailedName: null,
      review: 'none',
      approvals: { have: 0, need: null },
      conflict: false,
      unanswered: 0,
      checkedAt,
    };
  const have = pr.reviewers.filter((r) => !r.isContainer && r.vote >= 5).length;
  const need =
    evaluations.find((e) => e.typeName === 'Minimum number of reviewers')
      ?.minimumApproverCount ?? null;
  let review: ReviewState = 'waiting';
  if (pr.reviewers.some((r) => r.vote === -10)) review = 'changes-asked';
  else if (
    pr.reviewers.some((r) => r.vote === 10 || r.vote === 5) &&
    (need === null || have >= need)
  )
    review = 'approved';
  return {
    workspaceId,
    pr: {
      id: pr.pullRequestId,
      url: pr.webUrl,
      status: pr.status,
      isDraft: pr.isDraft,
      createdAt: pr.creationDate,
      closedAt: pr.closedDate,
    },
    ...ciOf(evaluations, statuses),
    review,
    approvals: { have, need },
    conflict: pr.mergeStatus === 'conflicts',
    unanswered: unansweredOf(threads, pr, me),
    checkedAt,
  };
}
