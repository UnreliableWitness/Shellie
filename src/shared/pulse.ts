import { z } from 'zod';

/** A task whose terminals were active within this long stays in Active. */
export const RECENT_MS = 4 * 3_600_000;

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

/** The pulse:get result: the snapshot plus when each task's terminals were last active (epoch ms). */
export type PulseView = PulseSnapshot & { lastActive: Record<string, number> };

export type Lifecycle =
  | 'needs-you'
  | 'active'
  | 'in-review'
  | 'merged'
  | 'parked';
export const LIFECYCLE_ORDER: Lifecycle[] = [
  'needs-you',
  'active',
  'in-review',
  'merged',
  'parked',
];
export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  'needs-you': 'Needs you',
  active: 'Active',
  'in-review': 'In review',
  merged: 'Merged',
  parked: 'Parked',
};

export type ChipKind =
  | 'ci-failing'
  | 'conflict'
  | 'changes-asked'
  | 'comments'
  | 'draft'
  | 'approved'
  | 'waiting'
  | 'finish';
export type Chip = {
  kind: ChipKind;
  text: string;
  tone: 'red' | 'amber' | 'green' | 'muted';
  workspaceId: string | null;
};
export type TaskLifecycle = {
  group: Lifecycle;
  chip: Chip | null;
  story: string;
  sortKey: number;
};

type Trouble =
  | 'ci-failing'
  | 'conflict'
  | 'changes-asked'
  | 'comments'
  | 'agent';
const SEVERITY: Trouble[] = [
  'ci-failing',
  'conflict',
  'changes-asked',
  'comments',
  'agent',
];
/** Larger than any epoch ms, so severity dominates the createdAt tie-break in a sort key. */
const SEVERITY_STEP = 1e14;

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

const createdMs = (p: PrPulse): number =>
  p.pr ? Date.parse(p.pr.createdAt) : 0;

function ageText(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return '<1h';
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function troubleChip(kind: Trouble, p: PrPulse): Chip | null {
  const base = { workspaceId: p.workspaceId };
  switch (kind) {
    case 'ci-failing':
      return { kind, text: 'CI failing', tone: 'red', ...base };
    case 'conflict':
      return { kind, text: 'Conflict', tone: 'red', ...base };
    case 'changes-asked':
      return { kind, text: 'Changes asked', tone: 'amber', ...base };
    case 'comments':
      return {
        kind,
        text: p.unanswered === 1 ? '1 comment' : `${p.unanswered} comments`,
        tone: 'amber',
        ...base,
      };
    case 'agent':
      return null;
  }
}

export function lifecycleOf(input: {
  pulses: PrPulse[];
  lastActiveAt: number | null;
  agentBlocked: boolean;
  now: number;
}): TaskLifecycle {
  const { pulses, lastActiveAt, agentBlocked, now } = input;
  const withPr = pulses.filter((p) => p.pr && p.pr.status !== 'abandoned');

  // Merged: every pulse has a live PR, all completed.
  if (
    pulses.length > 0 &&
    withPr.length === pulses.length &&
    withPr.every((p) => p.pr!.status === 'completed')
  ) {
    const closed = Math.max(
      ...withPr.map((p) => (p.pr!.closedAt ? Date.parse(p.pr!.closedAt) : 0)),
    );
    return {
      group: 'merged',
      chip: {
        kind: 'finish',
        text: 'Finish',
        tone: 'green',
        workspaceId: null,
      },
      story: 'PR merged',
      sortKey: closed,
    };
  }

  // Worst trouble across workspaces: by severity, then older PR first.
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
  const trouble: Trouble | null =
    worst?.kind ?? (agentBlocked ? 'agent' : null);

  const least = pulses.length === 0 ? 0 : Math.min(...pulses.map(rank));
  const published = pulses.filter((p) => rank(p) === 2);
  const oldest = [...published].sort((x, y) => createdMs(x) - createdMs(y))[0];
  const focus =
    worst?.p ??
    oldest ??
    pulses.find((p) => p.pr?.status === 'active') ??
    pulses[0];

  const story = storyOf(focus, worst ? worst.kind : null, agentBlocked, now);

  if (lastActiveAt !== null && now - lastActiveAt < RECENT_MS) {
    return {
      group: 'active',
      chip: worst ? troubleChip(worst.kind, worst.p) : null,
      story,
      sortKey: -lastActiveAt,
    };
  }
  if (trouble) {
    return {
      group: 'needs-you',
      chip: worst ? troubleChip(worst.kind, worst.p) : null,
      story,
      sortKey:
        SEVERITY.indexOf(trouble) * SEVERITY_STEP +
        (worst ? createdMs(worst.p) : 0),
    };
  }
  if (least === 2 && oldest) {
    const approved = published.every((p) => p.review === 'approved');
    const since = createdMs(oldest);
    return {
      group: 'in-review',
      chip: approved
        ? {
            kind: 'approved',
            text: 'Approved',
            tone: 'green',
            workspaceId: null,
          }
        : {
            kind: 'waiting',
            text: ageText(now - since),
            tone: 'muted',
            workspaceId: null,
          },
      story,
      sortKey: since,
    };
  }
  const draft = least === 1 ? pulses.find((p) => rank(p) === 1) : undefined;
  return {
    group: 'parked',
    chip: draft
      ? {
          kind: 'draft',
          text: 'Draft',
          tone: 'muted',
          workspaceId: draft.workspaceId,
        }
      : null,
    story,
    sortKey: lastActiveAt === null ? 0 : -lastActiveAt,
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
    if (!p.pr.isDraft) parts.push(`waiting ${ageText(now - createdMs(p))}`);
  }
  if (agentBlocked && trouble === null) parts.push('agent needs you');
  return parts.join(' · ');
}
