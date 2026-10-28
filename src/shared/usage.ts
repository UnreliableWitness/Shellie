import { z } from 'zod';
import { BudgetSettingsSchema, defaultBudgetSettings } from './budget';
import { defaultEditorPrefs, EditorPrefsSchema } from './editors';
import { defaultTerminals, DefaultTerminalsSchema } from './terminals';
import { THEMES } from './theme';
import { WorkHoursSchema } from './time';

export type UsageTool = 'claude-code' | 'copilot-cli' | 'opencode';

/** One AI request as captured from telemetry, before pricing. */
export type UsageEvent = {
  id: string;
  taskId: string;
  tool: UsageTool;
  sessionId: string;
  model: string;
  at: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  fast: boolean;
  /** Set on Shellie's own `claude -p` run for the PR description. */
  source?: 'pr-summary';
  /** The subagent that made the request (Claude Code's `query_source`, OpenCode's agent); absent on the main thread. */
  agent?: string;
  /** OpenCode: the session that spawned this (subagent) session. */
  parentSessionId?: string;
  /** The reasoning effort, when the tool reports one (Claude Code). */
  effort?: string;
};

export type RateSnapshot = {
  inputPerM: number;
  cachedInputPerM: number;
  cacheWritePerM: number;
  outputPerM: number;
};

export type UsageRecord = UsageEvent & {
  costUsd: number | null;
  rateId: string | null;
  rate: RateSnapshot | null;
};

export const RateSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  match: z.array(z.string().min(1)).min(1),
  minInputTokens: z.number().int().min(0),
  fast: z.boolean(),
  inputPerM: z.number().min(0),
  cachedInputPerM: z.number().min(0),
  cacheWritePerM: z.number().min(0),
  /** 1-hour cache write price; absent means the 5-minute price applies. */
  cacheWrite1hPerM: z.number().min(0).optional(),
  outputPerM: z.number().min(0),
});
export type Rate = z.infer<typeof RateSchema>;

/** Built-in exchange rate used for every EUR amount, so all teammates on the same Shellie version write identical numbers. Changes only with an app update. */
export const OFFICIAL_USD_TO_EUR = 0.92;

const OnboardingSchema = z.object({
  dismissedAt: z.string().nullable().default(null),
  agentsCheckedAt: z.string().nullable().default(null),
  tracker: z.literal('none').nullable().default(null),
  /** Set on the first start of the version with the first-run page, so its migration for existing installs runs once. */
  migrated: z.boolean().default(false),
});

export const AppSettingsSchema = z.object({
  version: z.literal(1),
  receiverPort: z.number().int().min(1024).max(65535),
  /** Write booked time to Azure DevOps (Completed and Remaining Work) at Finish. Off by default. */
  writeTimeToAdo: z.boolean().default(false),
  /** Minutes without input before a terminal stops counting as active. */
  idleMinutes: z.number().int().min(1).max(60).default(5),
  workHours: WorkHoursSchema.default({
    start: '09:00',
    end: '17:00',
    days: [1, 2, 3, 4, 5],
  }),
  showSplash: z.boolean().default(true),
  /** Notify when an agent finishes its turn (blocked agents always notify). */
  notifyOnDone: z.boolean().default(true),
  /** Light or dark look; `system` follows the OS appearance (sets nativeTheme.themeSource). */
  theme: z.enum(THEMES).default('system'),
  /** The developer's monthly Claude budget (Home's Claude budget band). */
  claudeBudget: BudgetSettingsSchema.default(defaultBudgetSettings()),
  /** The developer's monthly Copilot budget (Copilot CLI and OpenCode through GitHub Copilot). */
  copilotBudget: BudgetSettingsSchema.default(defaultBudgetSettings()),
  /** Send anonymous usage and error data (see docs/telemetry.md). */
  sendTelemetry: z.boolean().default(true),
  /** Which editor Open in editor uses, globally and per repo. */
  editor: EditorPrefsSchema.default(defaultEditorPrefs()),
  /** The tabs Start opens and New task pre-ticks (Settings > Terminals and agents). */
  defaultTerminals: DefaultTerminalsSchema.default(defaultTerminals()),
  /** Secrets: how long a task stays on Production before Shellie puts it back on Development. */
  secrets: z
    .object({
      productionMinutes: z.number().int().min(5).max(480).default(60),
    })
    .default({ productionMinutes: 60 }),
  /** First-run state: dismissed Get started, the one-time agent pre-tick, a chosen "no tracker". */
  onboarding: OnboardingSchema.default({
    dismissedAt: null,
    agentsCheckedAt: null,
    tracker: null,
    migrated: false,
  }),
  /** The version whose What's new card on Home was dismissed (or a fresh install's first version); unset before #126. */
  whatsNewSeen: z.string().nullable().optional(),
  /** Auto-update (packaged Windows builds). No UI yet: set false in settings.json to turn it off. */
  autoUpdate: z.boolean().optional(),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;
/** The required fields; every other setting takes its schema default. */
export const defaultSettings = (): AppSettings =>
  AppSettingsSchema.parse({ version: 1, receiverPort: 4319 });

export type SessionSummary = {
  sessionId: string;
  tool: UsageTool;
  startedAt: string;
  lastAt: string;
  models: string[];
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number; // priced part only
  unpricedRequests: number;
  billable: boolean;
};

export type ToolTotals = { costUsd: number; sessions: number; tokens: number };

/** One billable, priced request from the last 6 hours, for the usage timeline. */
export type RecentPoint = { at: string; tool: UsageTool; costEur: number };

/** Billable usage of one model (by readable label) through one tool, for the Usage tab's ring. */
export type ModelTotals = {
  tool: UsageTool;
  /** The first raw model id seen, such as `claude-sonnet-5-5`. */
  model: string;
  /** The rate table's readable name, such as "Claude Sonnet 5.5", else the normalized id. */
  label: string;
  costEur: number;
  tokens: number;
  requests: number;
  unpricedRequests: number;
};

export type TaskUsage = {
  taskId: string;
  sessions: SessionSummary[];
  billable: { costUsd: number; costEur: number; tokens: number };
  byTool: Record<UsageTool, ToolTotals & { costEur: number }>;
  unpricedRequests: number;
  usdToEur: number;
  recent: RecentPoint[];
  /** Billable sessions per model, most expensive first. */
  byModel: ModelTotals[];
  /** Billable sessions as trees of their subagents, oldest first; absent from older main processes. */
  lineage?: UsageNode[];
};

/** One node of the Usage tab's lineage: a session (root) or a subagent. Totals include the children. */
export type UsageNode = {
  id: string;
  /** The subagent's name; empty on a session root (the main thread). */
  label: string;
  tool: UsageTool;
  /** The model of most of the node's own requests, and its readable name. */
  model: string;
  modelLabel: string;
  /** The effort of the node's own requests, when the tool reports one. */
  effort: string | null;
  parentId: string | null;
  startedAt: string;
  costUsd: number;
  costEur: number;
  tokens: number;
  requests: number;
  unpricedRequests: number;
  children: UsageNode[];
};

export type ReceiverStatus = {
  listening: boolean;
  port: number;
  error: string | null;
  copilot: { records: number; unreadable: number };
};
