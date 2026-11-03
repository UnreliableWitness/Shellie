import { z } from 'zod';
import type { UsageTool } from './usage';

/** Each connection's rebuild must finish within this, or it counts as unreachable. */
export const HOME_TIMEOUT_MS = 15_000;
/** Opening Home or focusing the window rebuilds a snapshot older than this. */
export const HOME_MAX_AGE_MS = 60_000;
/** While Home shows and the window has focus, it rebuilds this often. */
export const HOME_POLL_MS = 300_000;

export const HomePrSchema = z.object({
  id: z.number().int(),
  repo: z.string(),
  title: z.string(),
  author: z.string(),
  authorId: z.string(),
  createdAt: z.string(),
  isDraft: z.boolean(),
  conflicts: z.boolean(),
  /** 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for author, -10 rejected; null when I am not a named reviewer. */
  myVote: z.number().int().nullable(),
  votes: z.object({
    approved: z.number().int(),
    waiting: z.number().int(),
    rejected: z.number().int(),
  }),
  url: z.string(),
});
export type HomePr = z.infer<typeof HomePrSchema>;

export const HomeItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  state: z.string(),
  areaPath: z.string(),
  iterationPath: z.string(),
  assignedTo: z.string().nullable(),
  url: z.string(),
  project: z.string().nullable().default(null),
  remainingWork: z.number().nullable(),
  originalEstimate: z.number().nullable(),
  completedWork: z.number().nullable(),
});
export type HomeItem = z.infer<typeof HomeItemSchema>;

export const HomeSprintSchema = z.object({
  iterationId: z.string(),
  name: z.string(),
  path: z.string(),
  startDate: z.string().nullable(),
  finishDate: z.string().nullable(),
  items: z.array(HomeItemSchema),
});
export type HomeSprint = z.infer<typeof HomeSprintSchema>;

export const HomeConnectionSchema = z.object({
  connectionId: z.string(),
  name: z.string(),
  project: z.string(),
  /** stale: this build failed and the last data is kept; error: failed with no earlier data. */
  status: z.enum(['ok', 'stale', 'error']),
  error: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  sprints: z.array(HomeSprintSchema),
  sprintsError: z.string().nullable(),
  reviews: z.array(HomePrSchema),
  teamReviews: z.array(HomePrSchema),
  myPrs: z.array(HomePrSchema),
  prsError: z.string().nullable(),
});
export type HomeConnection = z.infer<typeof HomeConnectionSchema>;

export const HomeSnapshotSchema = z.object({
  version: z.literal(1),
  builtAt: z.string(),
  connections: z.array(HomeConnectionSchema),
});
export type HomeSnapshot = z.infer<typeof HomeSnapshotSchema>;

export type HomePeriod = 'week' | 'month';

export type HomeStats = {
  period: HomePeriod;
  from: string;
  to: string;
  costEur: number;
  costByTool: Record<UsageTool, number>;
  /** connectionId null: tasks whose repo has no connection. Largest first. */
  costByConnection: { connectionId: string | null; costEur: number }[];
  activeSeconds: number;
  agentSeconds: number;
  /** Booked ÷ estimated over finished tasks with both; null when there are none. */
  accuracy: number | null;
  accuracyTasks: number;
  tasksFinished: number;
  prsOpened: number;
};

/** The period as epoch ms in local time: this week from Monday 00:00, or this month from the 1st, up to now. */
export function periodRange(
  period: HomePeriod,
  now: Date,
): { from: number; to: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === 'week')
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  else start.setDate(1);
  return { from: start.getTime(), to: now.getTime() };
}

export type StateCategory = 'Proposed' | 'InProgress' | 'Completed' | 'Removed';
const CATEGORIES: StateCategory[] = [
  'Proposed',
  'InProgress',
  'Completed',
  'Removed',
];
const BY_NAME: Record<string, StateCategory> = {
  new: 'Proposed',
  'to do': 'Proposed',
  proposed: 'Proposed',
  approved: 'Proposed',
  done: 'Completed',
  closed: 'Completed',
  completed: 'Completed',
  removed: 'Removed',
};

/** The state's category from the type metadata, else a guess from common state names, else InProgress. ADO's `Resolved` category counts as InProgress. */
export function stateCategory(
  fromMeta: string | null | undefined,
  state: string,
): StateCategory {
  if (fromMeta && (CATEGORIES as string[]).includes(fromMeta))
    return fromMeta as StateCategory;
  return BY_NAME[state.toLowerCase()] ?? 'InProgress';
}
