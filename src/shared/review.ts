import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{7,64}$/, 'a commit id');

export const ReviewScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('uncommitted') }),
  /** One commit (from === to) or a range, oldest first, in one repo of the task. */
  z.object({
    kind: z.literal('commits'),
    workspaceId: z.string().min(1),
    from: sha,
    to: sha,
  }),
]);
export type ReviewScope = z.infer<typeof ReviewScopeSchema>;

export type ReviewFileStatus = 'A' | 'M' | 'D' | 'R';
/** `hash` is the git blob id of the after side (DELETED_HASH for a deleted file); "viewed" is stored against it. */
export type ReviewFile = {
  path: string;
  oldPath?: string;
  status: ReviewFileStatus;
  added: number;
  removed: number;
  binary: boolean;
  hash: string;
  /** The added lines hold a stored secret's value (any environment). Never says which. */
  secret?: boolean;
};
export const DELETED_HASH = 'deleted';
/** What the renderer sends to name a file it wants to read; main validates the paths. */
export type ReviewFileRef = Pick<
  ReviewFile,
  'path' | 'oldPath' | 'status' | 'binary'
>;
export const ReviewFileRefSchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  status: z.enum(['A', 'M', 'D', 'R']),
  binary: z.boolean(),
});
export type ReviewCommit = {
  sha: string;
  subject: string;
  author: string;
  date: string;
};
/** One repo of the task. `error` replaces the file list when git failed or the worktree is gone. */
export type ReviewRepo = {
  workspaceId: string;
  name: string;
  base: string | null;
  commits: ReviewCommit[];
  files: ReviewFile[];
  /** Paths staged, unstaged or untracked against HEAD, whatever the scope. */
  uncommitted: number;
  /** The repo's `review.collapse` globs from `.shellie.yml`, added to DEFAULT_COLLAPSE. */
  collapse: string[];
  error?: string;
};
export type ReviewFiles = { repos: ReviewRepo[] };
/** Text is null for binary files and files over the size limit; sizes are in bytes. */
export type FileContent = {
  before: string | null;
  after: string | null;
  binary: boolean;
  tooLarge: boolean;
  beforeSize: number;
  afterSize: number;
};

const ReviewSideSchema = z.enum(['before', 'after']);
export type ReviewSide = z.infer<typeof ReviewSideSchema>;
const ReviewCommentStatusSchema = z.enum([
  'open',
  'sent',
  'resolved',
  'outdated',
]);

/** Lines are 1-based and refer to the working-tree file (after) or the base file (before). */
const ReviewCommentSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  /** The base path of a renamed file; the before side is read there. */
  oldPath: z.string().min(1).optional(),
  side: ReviewSideSchema,
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  /** The commented lines when the comment was made, used to find them again. */
  snippet: z.string(),
  /** Up to 3 lines above and below the snippet, to choose between equal snippets. */
  contextBefore: z.string(),
  contextAfter: z.string(),
  text: z.string(),
  status: ReviewCommentStatusSchema,
  createdAt: z.string(),
  sentAt: z.string().nullable().default(null),
  resolvedAt: z.string().nullable().default(null),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

export const NewReviewCommentSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  side: ReviewSideSchema,
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  text: z.string().min(1).max(20000),
});
export type NewReviewComment = z.infer<typeof NewReviewCommentSchema>;

export const ReviewStateSchema = z.object({
  version: z.literal(1),
  /** viewedKey → the file's hash when it was marked viewed. */
  viewed: z.record(z.string(), z.string()).default({}),
  comments: z.array(ReviewCommentSchema).default([]),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export const emptyReviewState = (): ReviewState => ({
  version: 1,
  viewed: {},
  comments: [],
});

/** What Finish shows: files in All changes, those not viewed at their current content, comments open or sent. */
export type ReviewSummary = {
  files: number;
  notViewed: number;
  unresolved: number;
};

/** Where a comment's lines are read: the base path for a before-side comment on a renamed file. */
export const commentReadPath = (c: {
  path: string;
  oldPath?: string;
  side: ReviewSide;
}): string => (c.side === 'before' ? (c.oldPath ?? c.path) : c.path);

export const viewedKey = (workspaceId: string, path: string): string =>
  `${workspaceId}:${path}`;

/** Collapsed under "Generated" in every repo. */
const DEFAULT_COLLAPSE = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.min.js',
  '*.map',
  'dist/**',
];

/**
 * A gitignore-like glob: `*` stays inside a folder, `**` crosses folders, `?` is one character. A pattern
 * without a slash matches the file name in any folder; with a slash it is anchored at the repo root.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.?\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(g.includes('/') ? `^${re}$` : `(?:^|/)${re}$`);
}

export function isGenerated(path: string, extra: string[] = []): boolean {
  return [...DEFAULT_COLLAPSE, ...extra].some((g) =>
    globToRegExp(g).test(path),
  );
}
