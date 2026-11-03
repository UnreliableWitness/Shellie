import type { BudgetTokens, BudgetTool, Vendor } from './budget';

/** Where a request's cost belongs. `organization` is the connection's organizationUrl. */
export type Attribution =
  | {
      level: 'task';
      taskId: string;
      organization: string;
      project: string;
      workItemId: number | null;
      workItemTitle: string | null;
      workItemType: string | null;
      repo: string;
    }
  | {
      level: 'repo';
      organization: string | null;
      project: string | null;
      repo: string;
    }
  | {
      level: 'brain';
      brainId: string;
      organization: string;
      project: string;
    }
  | { level: 'none' };

/** One AI request: tokens, list-price cost and who/what it belongs to. */
export type CostRecord = BudgetTokens & {
  id: string;
  tool: BudgetTool;
  provider: string;
  vendor: Vendor | null;
  model: string;
  modelLabel: string;
  at: string;
  fast: boolean;
  costUsd: number | null;
  costEur: number | null;
  rateId: string | null;
  billable: boolean;
  attribution: Attribution;
  developer: string | null;
  shellieVersion: string;
};

/** Attribution only goes up: none, repo, task (a brain ranks with task). */
export const LEVEL_RANK = { none: 0, repo: 1, task: 2, brain: 2 } as const;
