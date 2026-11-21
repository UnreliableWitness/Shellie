import { z } from 'zod';

export type CiState = 'failing' | 'running' | 'passing' | 'none';
export type ReviewState = 'changes-asked' | 'approved' | 'waiting' | 'none';

export const PrPulseSchema = z.object({
  workspaceId: z.string(),
  pr: z
    .object({
      id: z.number().int(),
      url: z.string(),
      status: z.enum(['active', 'completed', 'abandoned']),
      isDraft: z.boolean(),
      createdAt: z.string(),
      closedAt: z.string().nullable(),
    })
    .nullable(),
  ci: z.enum(['failing', 'running', 'passing', 'none']),
  ciFailedName: z.string().nullable(),
  review: z.enum(['changes-asked', 'approved', 'waiting', 'none']),
  approvals: z.object({
    have: z.number().int(),
    need: z.number().int().nullable(),
  }),
  conflict: z.boolean(),
  unanswered: z.number().int(),
  checkedAt: z.string(),
});
export type PrPulse = z.infer<typeof PrPulseSchema>;

export const PulseSnapshotSchema = z.object({
  tasks: z.record(z.string(), z.array(PrPulseSchema)),
  error: z.enum(['auth']).nullable(),
  checkedAt: z.string().nullable(),
});
export type PulseSnapshot = z.infer<typeof PulseSnapshotSchema>;

type Trouble = 'ci-failing' | 'conflict' | 'changes-asked' | 'comments';
const SEVERITY: Trouble[] = [
  'ci-failing',
  'conflict',
  'changes-asked',
  'comments',
];

/** Least advanced first: none/abandoned, draft, published, completed. */
function rank(p: PrPulse): number {
  if (!p.pr || p.pr.status === 'abandoned') return 0;
  if (p.pr.status === 'completed') return 3;
  return p.pr.isDraft ? 1 : 2;
}

function troubleOf(p: PrPulse): Trouble | null {
  if (p.pr?.status !== 'active') return null;
  if (p.ci === 'failing') return 'ci-failing';
  if (p.conflict) return 'conflict';
  if (p.review === 'changes-asked') return 'changes-asked';
  if (p.unanswered > 0) return 'comments';
  return null;
}

const createdMs = (p: PrPulse): number => {
  const t = p.pr ? Date.parse(p.pr.createdAt) : 0;
  return Number.isNaN(t) ? 0 : t;
};

function ageText(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return '<1h';
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Merged: at least one live PR, and all live PRs completed (no PR or an abandoned one does not block). */
function isMerged(pulses: PrPulse[]): boolean {
  const withPr = pulses.filter((p) => p.pr && p.pr.status !== 'abandoned');
  return withPr.length > 0 && withPr.every((p) => p.pr!.status === 'completed');
}

/** Worst trouble across workspaces: by severity, then older PR first. */
function worstTrouble(pulses: PrPulse[]): { kind: Trouble; p: PrPulse } | null {
  let worst: { kind: Trouble; p: PrPulse } | null = null;
  for (const p of pulses) {
    const kind = troubleOf(p);
    if (!kind) continue;
    if (
      !worst ||
      SEVERITY.indexOf(kind) < SEVERITY.indexOf(worst.kind) ||
      (kind === worst.kind && createdMs(p) < createdMs(worst.p))
    ) {
      worst = { kind, p };
    }
  }
  return worst;
}

/** The pulse a task's story is told about: the troubled one, else the longest-waiting published PR, else any active one. */
function focusOf(
  pulses: PrPulse[],
  worst: PrPulse | undefined,
): PrPulse | undefined {
  const published = pulses.filter((p) => rank(p) === 2);
  const oldest = [...published].sort((x, y) => createdMs(x) - createdMs(y))[0];
  return (
    worst ??
    oldest ??
    pulses.find((p) => p.pr?.status === 'active') ??
    pulses[0]
  );
}

const MERGED_STORY = 'PR merged';

export type TaskSignal = {
  state: 'waits' | 'merged' | 'none';
  /** One line for the tooltip; '' when there is nothing to say. */
  story: string;
  /** The workspace whose PR the wait is about; null for a blocked agent, merged and none. */
  prWorkspaceId: string | null;
};

/** What a task's PRs and agents ask of the developer, for the one mark on its row. Time plays no part. */
export function taskSignal(input: {
  pulses: PrPulse[];
  agentBlocked: boolean;
  now: number;
}): TaskSignal {
  const { pulses, agentBlocked, now } = input;
  // A blocked agent comes before merged: amber outranks the green check.
  if (!agentBlocked && isMerged(pulses))
    return { state: 'merged', story: MERGED_STORY, prWorkspaceId: null };
  const worst = worstTrouble(pulses);
  return {
    state: worst || agentBlocked ? 'waits' : 'none',
    story: storyOf(
      focusOf(pulses, worst?.p),
      worst?.kind ?? null,
      agentBlocked,
      now,
    ),
    prWorkspaceId: worst?.p.workspaceId ?? null,
  };
}

function storyOf(
  p: PrPulse | undefined,
  trouble: Trouble | null,
  agentBlocked: boolean,
  now: number,
): string {
  const parts: string[] = [];
  if (p && p.pr?.status === 'active') {
    if (p.ci === 'failing')
      parts.push(
        p.ciFailedName ? `CI failing: ${p.ciFailedName}` : 'CI failing',
      );
    if (p.conflict) parts.push('merge conflict');
    if (p.review === 'changes-asked') parts.push('changes asked');
    if (p.approvals.need !== null)
      parts.push(`${p.approvals.have} of ${p.approvals.need} approvals`);
    else if (p.approvals.have > 0) parts.push(`${p.approvals.have} approvals`);
    if (p.unanswered > 0)
      parts.push(
        `${p.unanswered} unanswered ${p.unanswered === 1 ? 'comment' : 'comments'}`,
      );
    if (!p.pr.isDraft && createdMs(p) > 0)
      parts.push(`waiting ${ageText(now - createdMs(p))}`);
  }
  if (agentBlocked && trouble === null) parts.push('agent needs you');
  return parts.join(' · ');
}
