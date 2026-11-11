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
export const isBrainModel = (model: string): model is BrainModel =>
  BrainModelSchema.safeParse(model).success;

export const BrainAgentSchema = z.enum(['claude', 'opencode']);
export type BrainAgent = z.infer<typeof BrainAgentSchema>;
export const BRAIN_AGENT_LABELS: Record<BrainAgent, string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
};

export const BrainOptionsSchema = z.object({
  contextInTaskMd: z.boolean().default(true),
  addDirForClaude: z.boolean().default(true),
  syncAfterRefresh: z.boolean().default(false),
  weeklyDigest: z.boolean().default(false),
  /** Long reads are written and brought up to date in the background, a few a day (skills v10). */
  writeLongReads: z.boolean().default(false),
  dailyTokenCap: z.number().int().positive().default(500_000),
  openBrainTerminalOnStart: z.boolean().default(false),
  model: BrainModelSchema.default('sonnet'),
  /** The coding agent that runs the brain's jobs. */
  agent: BrainAgentSchema.default('claude'),
  /** OpenCode's `provider/model` for the brain's jobs; null uses OpenCode's own default. */
  opencodeModel: z.string().nullable().default(null),
});
export type BrainOptions = z.infer<typeof BrainOptionsSchema>;

/**
 * `provider/model` (slashes allowed after the provider: `openrouter/vendor/model`) with no spaces or shell characters:
 * a typed model reaches OpenCode's command line as `-m`.
 */
const OPENCODE_MODEL = /^[\w.-]+\/[\w.:/-]+$/;
export const isOpencodeModel = (model: string): boolean =>
  OPENCODE_MODEL.test(model);
/** The model to pass as `-m`: null (OpenCode's default) when it is unset or not a valid `provider/model`. */
export const opencodeModelArg = (model: string | null): string | null =>
  model !== null && isOpencodeModel(model) ? model : null;

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
   * queued and which (fixed at its first run), the sources whose job finished, failed runs per source, and when it was
   * over. Null until it starts.
   */
  picturePass: z
    .object({
      startedAt: z.string(),
      total: z.number().int(),
      sources: z.array(z.string()).default([]),
      done: z.array(z.string()),
      failures: z.record(z.string(), z.number().int()).default({}),
      finishedAt: z.string().nullable(),
    })
    .nullable()
    .default(null),
  /** The pass that writes the brain's book: how many runs it has had. Null until it starts. */
  bookPass: z.object({ attempts: z.number().int() }).nullable().default(null),
  /**
   * Long reads written by themselves (`writeLongReads`): failed runs per target with the day of the last one, and
   * how many were started on `day` (days are local `yyyy-mm-dd`). Null until the first one.
   */
  readsPass: z
    .object({
      failures: z
        .record(
          z.string(),
          z.object({ count: z.number().int(), day: z.string() }),
        )
        .default({}),
      day: z.string().nullable().default(null),
      started: z.number().int().default(0),
    })
    .nullable()
    .default(null),
});
export type Brain = z.infer<typeof BrainSchema>;

/** The skills version that cites and marks pictures: pictures jobs, Re-evaluate and the one-time pass need it. */
export const PICTURES_TEMPLATES = 6;
/** Whether the brain's skills can re-evaluate pictures (templates v6 or later). */
export const picturesReady = (brain: Pick<Brain, 'templatesVersion'>) =>
  brain.templatesVersion >= PICTURES_TEMPLATES;

/** The skills version that has the OpenCode commands: a brain on OpenCode needs it. */
export const OPENCODE_TEMPLATES = 7;
/** Whether the brain's skills include the OpenCode commands (templates v7 or later). */
export const opencodeReady = (brain: Pick<Brain, 'templatesVersion'>) =>
  brain.templatesVersion >= OPENCODE_TEMPLATES;

/** The skills version that has the book skill: the book needs it. */
export const BOOK_TEMPLATES = 8;
/** Whether the brain's skills can write the book (templates v8 or later). */
export const bookReady = (brain: Pick<Brain, 'templatesVersion'>) =>
  brain.templatesVersion >= BOOK_TEMPLATES;
/** The skills version that writes whole conflicts and has `/settle`: the Settle view's actions need it. */
export const SETTLE_TEMPLATES = 9;
/** Whether the brain's skills can settle conflicts (templates v9 or later). */
export const settleReady = (brain: Pick<Brain, 'templatesVersion'>) =>
  brain.templatesVersion >= SETTLE_TEMPLATES;
/** The skills version that has `/write`: long reads and letters need it. */
export const WRITE_TEMPLATES = 10;
/** Whether the brain's skills can write long reads (templates v10 or later). */
export const writeReady = (brain: Pick<Brain, 'templatesVersion'>) =>
  brain.templatesVersion >= WRITE_TEMPLATES;
/** The job that makes a brain's first book: a sync in the background lane, run with the `book` argument. */
export const isBookJob = (j: Pick<BrainJob, 'kind' | 'background'>) =>
  j.kind === 'sync' && j.background;

/** OpenCode session titles of the brain's headless jobs start with this, so the terminal never takes one for its own. */
export const BRAIN_JOB_TITLE = 'Shellie brain job';

/** A question for the brain's read-only ask skill: the `/ask` command on Claude Code, plain text on OpenCode (a `/` message is not reliably run there). */
export const askPrompt = (agent: BrainAgent, q: string): string =>
  agent === 'opencode'
    ? `Load the ask skill and answer from this brain, reading only: ${q}`
    : `/ask ${q}`;

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
  /** What the finding is about, for the UI to act on (never its words): pictures that never reached the agent. */
  code: z.enum(['pictures-dropped']).optional(),
  at: z.string(),
  /** A contradiction or scope change as `/lint` (skills v9) writes it, kept as written: `conflictOf` reads it. */
  conflict: z.unknown().optional(),
});
export type BrainFinding = z.infer<typeof BrainFindingSchema>;

/** The findings a person settles in the Settle view; Shellie's own kinds have their own buttons. */
export const CONFLICT_KINDS: ReadonlySet<BrainFinding['kind']> = new Set([
  'contradiction',
  'scope-change',
]);
export type ConflictKind = 'contradiction' | 'scope-change';

const ConflictClaimSchema = z.object({
  page: z.string().min(1),
  quote: z.string(),
  source: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
});
export type ConflictClaim = z.infer<typeof ConflictClaimSchema>;

/** Two claims that disagree, as one question: for a scope change, `a` is the agreed scope and `b` the new source. */
export const ConflictSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  claims: z.object({ a: ConflictClaimSchema, b: ConflictClaimSchema }),
  suggestion: z
    .object({
      pick: z.enum(['a', 'b', 'both', 'neither']).nullable().default(null),
      reason: z.string().default(''),
    })
    .nullable()
    .default(null),
  /** The decision page a newer source disagrees with again: shown as open despite that settle. */
  reopens: z.string().nullable().default(null),
});
export type Conflict = z.infer<typeof ConflictSchema>;

/** The finding's conflict when lint wrote a whole one; null for an older or malformed finding. */
export function conflictOf(f: BrainFinding): Conflict | null {
  const r = ConflictSchema.safeParse(f.conflict);
  return r.success ? r.data : null;
}

/** The finding's conflict id, or for an older finding its kind, page and words. */
export const conflictIdOf = (f: BrainFinding): string =>
  conflictOf(f)?.id ?? `${f.kind}:${f.page}:${f.detail}`;

/** What the person chose: a/b/both/neither for a contradiction, accept/keep for a scope change, write for an older finding. */
export const SettleChoiceSchema = z.enum([
  'a',
  'b',
  'both',
  'neither',
  'accept',
  'keep',
  'write',
]);
export type SettleChoice = z.infer<typeof SettleChoiceSchema>;

/** Everything the `/settle` skill needs, kept until the settle is done so it can run again. */
export const SettleDecisionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['contradiction', 'scope-change']),
  page: z.string(),
  question: z.string(),
  detail: z.string(),
  claims: z
    .object({ a: ConflictClaimSchema, b: ConflictClaimSchema })
    .nullable(),
  choice: SettleChoiceSchema,
  /** How both fit, or what is true (both, neither, write). */
  text: z.string().nullable(),
  why: z.string().nullable(),
  /** The source holding someone's answer, when the conflict was parked and answered. */
  answer: z.string().nullable(),
});
export type SettleDecision = z.infer<typeof SettleDecisionSchema>;

/** An open or parked conflict for the Settle view; `conflict` is null for an older finding (detail only). */
export type BrainConflictRow = {
  id: string;
  kind: ConflictKind;
  page: string;
  detail: string;
  at: string;
  conflict: Conflict | null;
  /** Someone's reply to the question asked, kept as a source for the settle to read. */
  answer?: { path: string; text: string } | null;
};
export type ParkedConflictRow = BrainConflictRow & {
  question: string;
  parkedAt: string;
};
export type SettledConflictRow = {
  id: string;
  question: string;
  choice: SettleChoice;
  text: string | null;
  at: string;
  status: 'pending' | 'done' | 'failed';
  /** The decision page the settle wrote, once done. */
  page: string | null;
  error: string | null;
};
/** `answers`: the answer sources of pending or failed settles, which count as in flight rather than uncaptured. */
export type BrainConflicts = {
  open: BrainConflictRow[];
  parked: ParkedConflictRow[];
  settled: SettledConflictRow[];
  answers: string[];
};

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
  | 'pictures'
  /** A conflict the person settled: runs `/settle` with the decision kept in brain/conflicts.json. */
  | 'settle'
  /** A long read written or brought up to date: runs `/write` on the job's `target`. */
  | 'write';
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
  /** The agent that runs this job, taken from the brain when it is queued and again when it starts. */
  agent: BrainAgent;
  /** The model this one job runs on (a capture added with Capture with); null is the brain's. One for the other agent is ignored. */
  model: string | null;
  /** A settle job's conflict id. */
  conflict?: string;
  /** What a write job writes (`writeTarget`): a chapter, a topic, or the long read it brings up to date. */
  target?: string;
};

/** Whether the path is a long read (`reads/<name>.md`), not a letter. No backslash: on Windows it is a separator. */
export const isLongRead = (p: string) => /^reads\/[^/\\]+\.md$/.test(p);
/** Whether the path is a letter about a long read (`reads/letters/<name>.md`). */
export const isLetter = (p: string) => /^reads\/letters\/[^/\\]+\.md$/.test(p);
/** A topic for a long read is one line a person typed. */
export const MAX_TOPIC = 200;
/** What a `write` job is for: a long read on a chapter of the book, on a topic, or an existing one brought up to date. */
export type WriteTarget =
  | { chapter: string }
  | { topic: string }
  | { update: string };
/** A target as a job carries it: `chapter:<title>`, `topic:<text>`, or the long read's path for an update. */
export const writeTarget = (t: WriteTarget): string =>
  'chapter' in t
    ? `chapter:${t.chapter}`
    : 'topic' in t
      ? `topic:${t.topic}`
      : t.update;
/** The target a job carries, or null when it is none of the three. */
export function parseWriteTarget(target: string): WriteTarget | null {
  if (target.startsWith('chapter:')) return { chapter: target.slice(8) };
  if (target.startsWith('topic:')) return { topic: target.slice(6) };
  return isLongRead(target) ? { update: target } : null;
}

/** A long read as the Read view lists it. */
export type BrainReadRow = {
  path: string;
  title: string;
  summary: string;
  /** The book chapter it is the long read of, as the book titles it now; null for a topic or a chapter that is gone. */
  chapter: string | null;
  /** What the person asked for, for a read on a topic. */
  topic: string | null;
  /** The day it was written or last brought up to date, as written. */
  written: string | null;
  minutes: number;
  /** A hash of the file: a reader's mark is for this text. */
  hash: string;
  /** Pages changed, gone or new since it was written; empty when it is up to date. */
  stale: string[];
};
/** A letter about what changed in a long read. */
export type BrainLetterRow = {
  path: string;
  title: string;
  /** The long read it is about. */
  read: string;
  written: string | null;
  minutes: number;
  hash: string;
};
export type BrainReads = { reads: BrainReadRow[]; letters: BrainLetterRow[] };
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
  /** Why queued jobs wait for the user (an OpenCode brain on skills older than v7); null when they run. */
  queueHeld: string | null;
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
  'subject',
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

/** Page types that stay at the back of the book, outside its chapters. */
export const BACK_OF_BOOK_TYPES: ReadonlySet<BrainPageType> = new Set([
  'decision',
  'meeting',
  'digest',
  'lesson',
  'glossary',
]);

/** A chapter of the brain's book: a title, a short summary, an intro and the wiki pages it orders. */
export type BrainChapter = {
  title: string;
  summary: string;
  intro: string;
  pages: string[];
};
/** `brain/book.json`: the wiki pages ordered into chapters. */
export type BrainBook = { chapters: BrainChapter[] };

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
  /** Picture files the page links or embeds, repo-relative, in document order, each once. */
  pictures: string[];
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
