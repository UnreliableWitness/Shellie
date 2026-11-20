import { z } from 'zod';
import { isOpencodeModel } from './brain';

/** The title every dream session carries, so the job and its sessions can be told apart from normal work. */
export const DREAM_JOB_TITLE = 'Shellie dream';

export const DreamLimitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tokens'), perDay: z.number().int().min(1) }),
  z.object({ kind: z.literal('eur'), perDay: z.number().positive() }),
  z.object({ kind: z.literal('none') }),
]);
export type DreamLimit = z.infer<typeof DreamLimitSchema>;

/**
 * OpenCode's own configuration: config files, and the folder that holds agents, plugins (code OpenCode runs) and more.
 * A dream never writes these, at any depth: OpenCode refuses the edit, and later steps refuse them as allowed folders
 * and revert them after a run.
 */
export const DREAM_PROTECTED = ['opencode.json', 'opencode.jsonc', '.opencode'];

/**
 * Whether a repo-relative path is or lies in one of `DREAM_PROTECTED`. Without regard to case: on macOS and Windows
 * `OpenCode.json` is the same file as `opencode.json`.
 */
export function isProtectedPath(repoRelativePath: string): boolean {
  return repoRelativePath
    .toLowerCase()
    .split(/[\\/]/)
    .some((segment) => DREAM_PROTECTED.includes(segment));
}

/**
 * A real repo-relative sub-path (a folder, or a single file such as `AGENTS.md`): forward slashes, not absolute, no
 * `.`, `..` or empty segment (so not `.`, `./x`, `a/` or `a//b`), and not OpenCode's own configuration.
 */
const DreamFolderSchema = z
  .string()
  .min(1)
  .refine(
    (f) =>
      !f.startsWith('/') &&
      !f.includes('\\') &&
      !/^[A-Za-z]:/.test(f) &&
      f.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..') &&
      !isProtectedPath(f),
    'a repo-relative sub-path with forward slashes, no . or .. or empty segment, and not OpenCode configuration',
  );

export const DreamRepoSchema = z.object({
  on: z.boolean(),
  folders: z.array(DreamFolderSchema),
});
export type DreamRepo = z.infer<typeof DreamRepoSchema>;

const ModelSchema = z.string().refine(isOpencodeModel, 'a provider/model');

export const DreamingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  model: ModelSchema.nullable().default(null),
  /** The model the last passed test was for. */
  testedModel: ModelSchema.nullable().default(null),
  /** Null until chosen. */
  limit: DreamLimitSchema.nullable().default(null),
  /** By repo id. */
  repos: z.record(z.string(), DreamRepoSchema).default({}),
  idleMinutes: z.number().int().min(1).max(120).default(10),
});
export type DreamingSettings = z.infer<typeof DreamingSettingsSchema>;

export const defaultDreaming = (): DreamingSettings => ({
  enabled: false,
  model: null,
  testedModel: null,
  limit: null,
  repos: {},
  idleMinutes: 10,
});

/** Null when dreaming may be switched on; else the first missing thing. */
export function canSwitchOn(
  d: DreamingSettings,
): null | 'model' | 'test' | 'limit' | 'repos' {
  if (d.model === null) return 'model';
  if (d.testedModel !== d.model) return 'test';
  if (d.limit === null) return 'limit';
  if (!Object.values(d.repos).some((r) => r.on && r.folders.length > 0))
    return 'repos';
  return null;
}

const limitWidens = (p: DreamLimit | null, n: DreamLimit | null): boolean => {
  if (n === null) return false;
  if (p === null || p.kind !== n.kind) return true;
  if (n.kind === 'none') return false;
  return n.perDay > (p as { perDay: number }).perDay;
};

/** True when `next` sends more text to the model or may spend or change more than `prev`. */
export function widens(
  prev: DreamingSettings,
  next: DreamingSettings,
): boolean {
  for (const [id, repo] of Object.entries(next.repos)) {
    if (!repo.on) continue;
    const before = prev.repos[id];
    if (!before?.on) return true;
    if (repo.folders.some((f) => !before.folders.includes(f))) return true;
  }
  return limitWidens(prev.limit, next.limit);
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

const spaced = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const limitText = (l: DreamLimit | null): string => {
  if (l === null || l.kind === 'none') return 'with no limit';
  if (l.kind === 'eur') return `up to € ${l.perDay.toFixed(2)} a day`;
  const t =
    l.perDay % 1e6 === 0 ? `${l.perDay / 1e6} million` : spaced(l.perDay);
  return `up to ${t} tokens a day`;
};

export function confirmSentence(
  d: DreamingSettings,
  repoNames: string[],
): string {
  return (
    `Dreams run on OpenCode with ${d.model}, when this machine is idle, ` +
    `for ${plural(repoNames.length, 'repo', 'repos')} (${repoNames.join(', ')}), ` +
    `${limitText(d.limit)}. ` +
    `What was said in those repos' agent sessions is sent to that model.`
  );
}

export type DreamProposalKind =
  | 'new-rule'
  | 'changed-rule'
  | 'new-skill'
  | 'changed-skill'
  | 'new-agent'
  | 'changed-agent';

export const DreamEvidenceSchema = z.object({
  taskId: z.string(),
  label: z.string(),
  date: z.string(),
  quote: z.string(),
});
export type DreamEvidence = z.infer<typeof DreamEvidenceSchema>;

export const DreamProposalSchema = z.object({
  id: z.string(),
  kind: z.enum([
    'new-rule',
    'changed-rule',
    'new-skill',
    'changed-skill',
    'new-agent',
    'changed-agent',
  ]),
  title: z.string(),
  why: z.string(),
  evidence: z.array(DreamEvidenceSchema),
  files: z.array(z.string()),
  commit: z.string(),
  dropped: z.boolean(),
});
export type DreamProposal = z.infer<typeof DreamProposalSchema>;

export const DreamResultSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  branch: z.string(),
  baseSha: z.string(),
  worktreePath: z.string(),
  dataDir: z.string(),
  at: z.string(),
  model: z.string(),
  tokens: z.number(),
  sessions: z.number(),
  proposals: z.array(DreamProposalSchema),
  /** Paths changed outside the allowed folders. */
  reverted: z.array(z.string()),
  removedByCheck: z.number(),
});
export type DreamResult = z.infer<typeof DreamResultSchema>;

export const DreamJournalEntrySchema = z.object({
  dreamId: z.string(),
  repoId: z.string(),
  at: z.string(),
  model: z.string(),
  tokens: z.number(),
  outcome: z.enum([
    'proposed',
    'nothing',
    'interrupted',
    'limit',
    'wrong-model',
    'failed',
  ]),
  /** Why it was interrupted or failed. */
  reason: z.string().nullable(),
  proposals: z.number(),
  removedByCheck: z.number(),
  closed: z
    .object({
      as: z.enum(['task', 'discarded']),
      kept: z.number(),
      dropped: z.number(),
      taskName: z.string().nullable(),
    })
    .nullable(),
});
export type DreamJournalEntry = z.infer<typeof DreamJournalEntrySchema>;

export const DreamSightingSchema = z.object({
  at: z.string(),
  note: z.string(),
  taskId: z.string(),
  quote: z.string(),
});
export type DreamSighting = z.infer<typeof DreamSightingSchema>;

export const DreamRejectionSchema = z.object({
  at: z.string(),
  title: z.string(),
  why: z.string(),
});
export type DreamRejection = z.infer<typeof DreamRejectionSchema>;

export const DreamRepoStateSchema = z.object({
  /** Task id to the time (ms) of the last covered turn. */
  covered: z.record(z.string(), z.number()),
  sightings: z.array(DreamSightingSchema),
  rejections: z.array(DreamRejectionSchema),
  failures: z.number(),
  lastFailureAt: z.string().nullable(),
  lastFailure: z.string().nullable(),
  lastDreamAt: z.string().nullable(),
  lastOutcome: z.enum(['proposed', 'nothing']).nullable(),
  /** The one open result. */
  result: DreamResultSchema.nullable(),
});
export type DreamRepoState = z.infer<typeof DreamRepoStateSchema>;
