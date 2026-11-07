import { z } from 'zod';
import { TerminalDefSchema } from './types';

/** Usage and terminals for a brain are attributed to this pseudo task id. */
const BRAIN_TASK_PREFIX = 'brain:';
export const brainTaskId = (brainId: string) =>
  `${BRAIN_TASK_PREFIX}${brainId}`;
export const brainIdOf = (taskId: string | undefined): string | null =>
  taskId?.startsWith(BRAIN_TASK_PREFIX)
    ? taskId.slice(BRAIN_TASK_PREFIX.length)
    : null;

const BrainModelSchema = z.enum(['haiku', 'sonnet', 'opus']);
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
export type BrainOptions = z.infer<typeof BrainOptionsSchema>;

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
  /** Kept but quiet: out of the nav, no task gets it, no scheduled work, no jobs. Settings lists it for Restore. */
  archived: z.boolean().default(false),
  /**
   * The one-time pass over sources added before picture coverage (templates v6): when it started, how many sources it
   * queued, the sources whose job finished, and when it was over. Null until it starts.
   */
  picturePass: z
    .object({
      startedAt: z.string(),
      total: z.number().int(),
      done: z.array(z.string()),
      finishedAt: z.string().nullable(),
    })
    .nullable()
    .default(null),
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

/**
 * A finding on a page: Shellie finds `broken-link`, `stale`, `uncaptured`, `frontmatter` and `picture` (on a source)
 * itself on every Health read; `/lint` writes `contradiction` and `scope-change` into state. `orphan` is a kind older lints wrote.
 */
const BrainFindingSchema = z.object({
  kind: z.enum([
    'contradiction',
    'orphan',
    'broken-link',
    'stale',
    'uncaptured',
    'scope-change',
    'frontmatter',
    'picture',
  ]),
  page: z.string(),
  detail: z.string(),
  at: z.string(),
});
export type BrainFinding = z.infer<typeof BrainFindingSchema>;

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
  findings: z.array(BrainFindingSchema).default([]),
});
export type BrainState = z.infer<typeof BrainStateSchema>;

/** `capture`, `retract`, `lessons` and `pictures` take a source path; the others run on the whole brain. */
export type BrainJobKind =
  | 'capture'
  | 'sync'
  | 'lint'
  | 'digest'
  | 'retract'
  | 'lessons'
  | 'pictures';
export const SOURCE_JOB_KINDS: ReadonlySet<BrainJobKind> = new Set([
  'capture',
  'retract',
  'lessons',
  'pictures',
]);
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
  /** Runs only when no other job is queued (the one-time pass over earlier sources). */
  background: boolean;
};
export type PictureStatus =
  | 'described'
  | 'skipped'
  | 'missing'
  | 'dropped'
  | 'accepted';
/** One picture of a source and what became of it: a stored file, or a drop the converter could not deliver. */
export type PictureRow = {
  /** Repo-relative picture file; null for a drop (no file). */
  path: string | null;
  /** 'Slide 4', 'Page 3', 'Slide layouts and master', 'Picture 2', 'Wiki attachment'. */
  label: string;
  /** From the source's `![alt](path)`, null when none. */
  alt: string | null;
  status: PictureStatus;
  /** Wiki pages citing it (described). */
  pages: string[];
  /** Skip reason, or drop reason. */
  reason: string | null;
  /** Drops only. */
  fix: string | null;
  /** Drops only, the key used to accept it. */
  where: string | null;
};
export type PictureCounts = {
  total: number;
  described: number;
  skipped: number;
  missing: number;
  dropped: number;
  accepted: number;
  /** PDF images too small to extract: counted, never a row. */
  tiny: number;
};
export type SourcePictures = {
  source: string;
  counts: PictureCounts;
  rows: PictureRow[];
};

/** How many wiki pages and sources a brain has (`brain:counts`). */
export type BrainCounts = { pages: number; sources: number };

export type BrainSourceRow = {
  path: string;
  type: SourceType;
  ingestedAt: string;
  captured: boolean;
  original: string | null;
  /** What the file holds, in one line; null for wiki pages and older sources. */
  contents: string | null;
  /** What the person who added it said about it, or null. */
  note: string | null;
};
export type BrainHealth = {
  state: BrainState | null;
  stateError: string | null;
  /** Shellie's own findings (computed now), then the lint's from state (`contradiction`, `scope-change`). */
  findings: BrainFinding[];
  /** Pages under wiki/. */
  pages: number;
  uncaptured: number;
  mirrorPages: number;
  outsideEdits: string[];
  queuePaused: 'cap' | null;
  costEurToday: number;
  tokensToday: number;
  /** The pictures of all sources, summed (accepted drops and tiny images are not gaps). */
  pictures: PictureCounts;
};
/** `health` (git, the ledger and the sources read) only from `brain:get`; null from the lists and the other channels. */
export type BrainView = Brain & {
  health: BrainHealth | null;
  jobs: BrainJob[];
};

/** Page types by file name, in the order the front page shows them. */
export const BRAIN_PAGE_TYPES = [
  'account',
  'scope',
  'component',
  'glossary',
  'decision',
  'meeting',
  'lesson',
  'digest',
  'other',
] as const;
export type BrainPageType = (typeof BRAIN_PAGE_TYPES)[number];

/** A wiki page as the front page and the task tab show it, from its frontmatter and links. */
export type BrainPageRow = {
  path: string;
  title: string;
  /** '' when the page has neither a summary nor a first line. */
  summary: string;
  type: BrainPageType;
  /** `last_updated` as written, or null. */
  lastUpdated: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  /** The day a person checked the page, or null. */
  verified: string | null;
  changedSinceVerified: boolean;
  /** Sources the page cites, repo-relative. */
  sources: string[];
  /** Pages whose links point here, repo-relative. */
  linkedFrom: string[];
};

/** One line of a page or source matching a search. */
export type BrainSearchHit = {
  path: string;
  kind: 'page' | 'source';
  title: string;
  /** 1-based line in the file. */
  line: number;
  /** The matching line, cut around the match. */
  text: string;
  /** The slug of the nearest heading above the line, as the viewer ids it, or null. */
  anchor: string | null;
};

/** A wiki of an Azure DevOps project (REST `_apis/wiki/wikis`). */
export type AdoWiki = {
  id: string;
  name: string;
  type: 'projectWiki' | 'codeWiki';
  repositoryId: string;
  version: string;
  mappedPath: string;
  gitUrl: string;
};

export type AdoWikiPage = {
  path: string;
  gitItemPath: string;
  isParent: boolean;
};

export type AddSourceResult =
  | {
      ok: true;
      path: string;
      /** Pictures stored beside the source for Claude to look at. */
      images: number;
      /** Pictures left out of the source (for example an EMF with no rasterizer), recorded for the person to fix. */
      dropped: number;
      warnings: string[];
      /** What the source holds, in one line. */
      contents: string;
    }
  | {
      ok: false;
      reason: 'unsupported' | 'duplicate' | 'needs-ocr' | 'secret' | 'error';
      message: string;
    };

export type RefreshResult =
  | {
      ok: true;
      added: number;
      changed: number;
      removed: number;
      pages: number;
      /** Picture files of the mirror added, changed or removed. */
      attachments: number;
      warnings?: string[];
    }
  | { ok: false; message: string };
