import { z } from 'zod';

export const BudgetSettingsSchema = z.object({
  /** The monthly budget in EUR (Claude or Copilot); null means no budget (spend shown, no alerts). */
  monthlyEur: z.number().positive().nullable(),
  /** Day of the month the budget resets on (1-28). */
  monthStartDay: z.number().int().min(1).max(28),
  alerts: z.object({
    at80: z.boolean(),
    forecastOver: z.boolean(),
    at100: z.boolean(),
  }),
});
export type BudgetSettings = z.infer<typeof BudgetSettingsSchema>;
export const defaultBudgetSettings = (): BudgetSettings => ({
  monthlyEur: null,
  monthStartDay: 1,
  alerts: { at80: true, forecastOver: true, at100: true },
});

export type BudgetTool = 'claude-code' | 'opencode' | 'copilot-cli';

/** Which budget a request counts against. */
export type Vendor = 'claude' | 'copilot';
export const VENDORS: readonly Vendor[] = ['claude', 'copilot'];

/** Claude: Claude Code, or OpenCode through Anthropic. Copilot: Copilot CLI, or OpenCode through GitHub Copilot. Anything else is in no budget. */
export function vendorOf(r: {
  tool: BudgetTool;
  provider: string;
}): Vendor | null {
  if (r.tool === 'claude-code') return 'claude';
  if (r.tool === 'copilot-cli') return 'copilot';
  if (r.provider === 'anthropic') return 'claude';
  if (r.provider === 'github-copilot') return 'copilot';
  return null;
}

export type BudgetTokens = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
};

/** One AI request in the budget's local store, before rollup. */
export type BudgetRecord = BudgetTokens & {
  id: string;
  tool: BudgetTool;
  sessionId: string;
  model: string;
  provider: string;
  at: string;
  cwd: string | null;
  fast: boolean;
  /** The Shellie task the request belongs to, when known (Copilot CLI, PR summaries). */
  taskId?: string;
  /** OpenCode: the session that spawned this one, when it is a subagent's session. */
  parentSessionId?: string;
  /** OpenCode: the subagent's agent name, on a child session's requests. */
  agentLabel?: string;
};

/** One rollup row: a day x tool x model x provider x vendor x inShellie x fast. */
export type BudgetRow = BudgetTokens & {
  tool: BudgetTool;
  model: string;
  provider: string;
  /** The budget the row counts against; null is in no budget. */
  vendor: Vendor | null;
  inShellie: boolean;
  requests: number;
  fast: boolean;
  costEur: number | null;
};

/** A budget month: start inclusive, end exclusive, days as local 'YYYY-MM-DD' keys. */
export type BudgetMonth = { start: Date; end: Date; days: string[] };

/** The alert thresholds the budget band can raise. */
export type AlertKind = 'at80' | 'forecastOver' | 'at100';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day as 'YYYY-MM-DD'. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The budget month containing `now` (or `offset` months from it), starting on `startDay`. */
export function budgetMonth(
  now: Date,
  startDay: number,
  offset = 0,
): BudgetMonth {
  const before = now.getDate() < startDay ? -1 : 0;
  const start = new Date(
    now.getFullYear(),
    now.getMonth() + before + offset,
    startDay,
  );
  const end = new Date(start.getFullYear(), start.getMonth() + 1, startDay);
  const days: string[] = [];
  for (const d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    days.push(dayKey(d));
  }
  return { start, end, days };
}

/** All five token kinds added together. */
export const tokensOf = (t: BudgetTokens): number =>
  t.inputTokens +
  t.outputTokens +
  t.cacheReadTokens +
  t.cacheWrite5mTokens +
  t.cacheWrite1hTokens;
