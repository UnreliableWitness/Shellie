import { z } from 'zod';
import { TerminalDefSchema } from './types';

/** Usage and terminals for a brain are attributed to this pseudo task id. */
export const BRAIN_TASK_PREFIX = 'brain:';
export const brainTaskId = (brainId: string) =>
  `${BRAIN_TASK_PREFIX}${brainId}`;
export const brainIdOf = (taskId: string | undefined): string | null =>
  taskId?.startsWith(BRAIN_TASK_PREFIX)
    ? taskId.slice(BRAIN_TASK_PREFIX.length)
    : null;

export const BrainModelSchema = z.enum(['haiku', 'sonnet', 'opus']);
export type BrainModel = z.infer<typeof BrainModelSchema>;

export const BrainOptionsSchema = z.object({
  contextInTaskMd: z.boolean().default(true),
  addDirForClaude: z.boolean().default(true),
  syncAfterRefresh: z.boolean().default(false),
  weeklyDigest: z.boolean().default(false),
  dailyTokenCap: z.number().int().positive().default(500_000),
  openBrainTerminalOnStart: z.boolean().default(false),
  model: BrainModelSchema.default('sonnet'),
});

export const BrainWikiSchema = z.object({
  wikiId: z.string(),
  wikiName: z.string(),
  type: z.enum(['projectWiki', 'codeWiki']),
  repositoryId: z.string(),
  gitUrl: z.string(),
  version: z.string(),
  mappedPath: z.string(),
  /** '/' for the wiki root, else the page path as the pages API gives it ('/Customers/Acme/Second brain'). */
  rootPath: z.string(),
});
export type BrainWiki = z.infer<typeof BrainWikiSchema>;

export const BrainSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  connectionId: z.string().min(1),
  project: z.string().min(1),
  path: z.string().min(1),
  wiki: BrainWikiSchema.nullable().default(null),
  templatesVersion: z.number().int().default(0),
  options: BrainOptionsSchema.prefault({}),
  terminal: TerminalDefSchema.nullable().default(null),
  createdAt: z.string(),
  lastRefreshAt: z.string().nullable().default(null),
  lastDigestAt: z.string().nullable().default(null),
});
export type Brain = z.infer<typeof BrainSchema>;

export const BrainsFileSchema = z.object({
  brains: z.array(BrainSchema).default([]),
});
export type BrainsFile = z.infer<typeof BrainsFileSchema>;

export const SourceTypeSchema = z.enum([
  'sow',
  'deck',
  'doc',
  'transcript',
  'note',
  'task',
  'wiki-page',
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const BrainStateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  lastSyncCommit: z.string().nullable().default(null),
  lastLintAt: z.string().nullable().default(null),
  captured: z
    .record(
      z.string(),
      z.object({ at: z.string(), sessionId: z.string().nullable() }),
    )
    .default({}),
  findings: z
    .array(
      z.object({
        kind: z.enum([
          'contradiction',
          'orphan',
          'broken-link',
          'stale',
          'uncaptured',
          'scope-change',
        ]),
        page: z.string(),
        detail: z.string(),
        at: z.string(),
      }),
    )
    .default([]),
});
export type BrainState = z.infer<typeof BrainStateSchema>;

export type BrainJobKind = 'capture' | 'sync' | 'lint' | 'digest';
export type BrainJob = {
  id: string;
  brainId: string;
  kind: BrainJobKind;
  source: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'paused';
  startedAt: string | null;
  endedAt: string | null;
  sessionId: string | null;
  result: string | null;
  error: string | null;
};
export type BrainSourceRow = {
  path: string;
  type: SourceType;
  ingestedAt: string;
  captured: boolean;
  original: string | null;
};
export type BrainHealth = {
  state: BrainState | null;
  stateError: string | null;
  uncaptured: number;
  mirrorPages: number;
  outsideEdits: string[];
  queuePaused: 'cap' | null;
  costEurToday: number;
  tokensToday: number;
};
export type BrainView = Brain & { health: BrainHealth; jobs: BrainJob[] };
