import { z } from 'zod';
import { isOpencodeModel } from './brain';
import { plural } from './text';

/** The title every dream session carries, so the job and its sessions can be told apart from normal work. */
export const DREAM_JOB_TITLE = 'Shellie dream';

export const DreamLimitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tokens'), perDay: z.number().int().min(1) }),
  z.object({ kind: z.literal('eur'), perDay: z.number().positive() }),
  z.object({ kind: z.literal('none') }),
]);
export type DreamLimit = z.infer<typeof DreamLimitSchema>;

/**
 * What a dream never writes, at any depth: OpenCode's own configuration (config files, and the folder that holds
 * agents, plugins (code OpenCode runs) and more), and anything in a folder named `hooks` (hook scripts, such as apm's
 * `.apm/hooks/`, run by themselves once merged, with no model and no person in between). OpenCode refuses the edit,
 * and later steps refuse them as allowed folders and revert them after a run.
 */
export const DREAM_PROTECTED = [
  'opencode.json',
  'opencode.jsonc',
  '.opencode',
  'hooks',
];

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
 * `.`, `..` or empty segment (so not `.`, `./x`, `a/` or `a//b`), and not protected (`DREAM_PROTECTED`).
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
    'a repo-relative sub-path with forward slashes, no . or .. or empty segment, not OpenCode configuration or hooks',
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

/** 5000000 as "5 000 000". */
export const spacedNumber = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const limitText = (l: DreamLimit | null): string => {
  if (l === null || l.kind === 'none') return 'with no limit';
  if (l.kind === 'eur') return `up to € ${l.perDay.toFixed(2)} a day`;
  const t =
    l.perDay % 1e6 === 0 ? `${l.perDay / 1e6} million` : spacedNumber(l.perDay);
  return `up to ${t} tokens a day`;
};

/**
 * What `next` adds to `prev`, one line each: a repo switched on, a folder a dream may now also change, a limit that
 * is raised, removed or changed to another unit. Empty when `next` sends and spends no more. `nameOf` names a repo
 * (its id by default).
 */
export function widenings(
  prev: DreamingSettings,
  next: DreamingSettings,
  nameOf: (repoId: string) => string = (id) => id,
): string[] {
  const lines: string[] = [];
  for (const [id, repo] of Object.entries(next.repos)) {
    if (!repo.on) continue;
    const before = prev.repos[id];
    if (!before?.on)
      lines.push(
        repo.folders.length > 0
          ? `Adds repo ${nameOf(id)}, which may change ${repo.folders.join(', ')}`
          : `Adds repo ${nameOf(id)}`,
      );
    else
      for (const f of repo.folders)
        if (!before.folders.includes(f))
          lines.push(`${nameOf(id)} may now also change ${f}`);
  }
  const p = prev.limit;
  const n = next.limit;
  if (n !== null) {
    if (p === null) lines.push(`Sets the limit to ${limitText(n)}`);
    else if (p.kind !== n.kind)
      lines.push(
        n.kind === 'none'
          ? 'Removes the daily limit'
          : `Changes the limit from ${p.kind === 'none' ? 'no limit' : limitText(p)} to ${limitText(n)}`,
      );
    else if (n.kind !== 'none' && n.perDay > (p as { perDay: number }).perDay)
      lines.push(`Raises the limit from ${limitText(p)} to ${limitText(n)}`);
  }
  return lines;
}

/** True when `next` sends more text to the model or may spend or change more than `prev`. */
export function widens(
  prev: DreamingSettings,
  next: DreamingSettings,
): boolean {
  return widenings(prev, next).length > 0;
}

export function confirmSentence(
  d: DreamingSettings,
  repoNames: string[],
): string {
  return (
    `Dreams run on OpenCode with ${d.model}, when this machine is idle, ` +
    `for ${plural(repoNames.length, 'repo')} (${repoNames.join(', ')}), ` +
    `${limitText(d.limit)}. ` +
    `What was said in those repos' agent sessions is sent to that model.`
  );
}

export const DREAM_PROPOSAL_KINDS = [
  'new-rule',
  'changed-rule',
  'new-skill',
  'changed-skill',
  'new-agent',
  'changed-agent',
] as const;
export type DreamProposalKind = (typeof DREAM_PROPOSAL_KINDS)[number];

/** Who said a quote, as Shellie found it in the task's turns (`src/main/dreams/evidence.ts`). */
export const DreamEvidenceWhoSchema = z.enum(['you', 'agent', 'unknown']);
export type DreamEvidenceWho = z.infer<typeof DreamEvidenceWhoSchema>;

export const DreamEvidenceSchema = z.object({
  taskId: z.string(),
  label: z.string(),
  date: z.string(),
  quote: z.string(),
  /** Missing in a result stored before the check: reads as `unknown`. */
  who: DreamEvidenceWhoSchema.default('unknown'),
});
export type DreamEvidence = z.infer<typeof DreamEvidenceSchema>;

export const DreamProposalSchema = z.object({
  id: z.string(),
  kind: z.enum(DREAM_PROPOSAL_KINDS),
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

/** One line of a hunk as git wrote it; `note` is git's "\ No newline at end of file". */
export type DreamDiffLine = {
  kind: 'context' | 'add' | 'del' | 'note';
  text: string;
  oldNo: number | null;
  newNo: number | null;
};
export type DreamDiffHunk = { header: string; lines: DreamDiffLine[] };

/**
 * One file of a proposal's commit against its parent (`dream:diff`), as git's own patch has it: the hunks and the
 * added and removed lines counted from that same patch. No hunks for a binary file (`binary`), for a side over
 * 500 kB or a file past the answer's 2 MB (`tooLarge`; the counts are git's when it has them, else 0). At most 400
 * lines per file (`truncated` when cut), each line at most 2 000 characters.
 */
export type DreamFileDiff = {
  path: string;
  added: number;
  removed: number;
  hunks: DreamDiffHunk[];
  binary?: boolean;
  tooLarge?: boolean;
  truncated?: boolean;
};

/** Both texts of one file of a proposal (`dream:file`), for the full diff. */
export type DreamFileTexts =
  | { before: string; after: string }
  | { tooLarge: true }
  | { binary: true };

export const DreamJournalEntrySchema = z.object({
  dreamId: z.string(),
  repoId: z.string(),
  /** The repo's name when the dream ran, for a repo removed since; missing in an older entry. */
  repoName: z.string().optional(),
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

/**
 * A result opened as a task whose task is not made yet (`dream:openAsTask`): its branch, the kept proposals' count and
 * titles. `tasks:create` with `fromDream` makes the task on that branch and clears it; Leave the branch clears it too.
 */
export const DreamOpenedSchema = z.object({
  dreamId: z.string(),
  branch: z.string(),
  at: z.string(),
  kept: z.number(),
  titles: z.array(z.string()),
});
export type DreamOpened = z.infer<typeof DreamOpenedSchema>;

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
  /** A result opened as a task, until its task is made; missing in a file written before it existed. */
  opened: DreamOpenedSchema.nullable().default(null),
});
export type DreamRepoState = z.infer<typeof DreamRepoStateSchema>;

/**
 * Why dreaming switched itself off: a call of a dream of `repoId` was answered by `answered` instead of `chosen`;
 * `repoId` is empty for the setup's re-test of the dreaming model.
 */
export const DreamSwitchedOffSchema = z.object({
  answered: z.string(),
  chosen: z.string(),
  repoId: z.string(),
});
export type DreamSwitchedOff = z.infer<typeof DreamSwitchedOffSchema>;

/** Why no dream starts (`nextDream`, `src/main/dreams/ready.ts`), in the order the waits are checked. */
export type DreamWait =
  | 'off'
  | 'model-missing'
  | 'active'
  | 'battery'
  | 'agents-busy'
  | 'running'
  | 'limit'
  | 'nothing-ready';

/** What dreams used in one local day. */
export type DreamUsage = {
  day: string;
  tokens: number;
  /** Null when a model that was used has no rate: the spend cannot be measured. */
  eur: number | null;
};

/** Everything the Dreams screens show (`dream:get`). */
export type DreamView = {
  settings: DreamingSettings;
  /**
   * OpenCode's model list as already known (the scheduler's or `agents:opencodeModels`'s last answer); null when not
   * known. `dream:get` never asks OpenCode for it; the setup's picker reads `agents:opencodeModels`.
   */
  models: string[] | null;
  /** The rate table prices the chosen model, so a euro limit can be offered. */
  euroLimitOffered: boolean;
  usage: DreamUsage;
  /** Why no dream starts; null while one runs, before the first check, or before the scheduler started. */
  waiting: DreamWait | null;
  /** The repo that dreams next as far as the scheduler knows, with its count of sessions to read. */
  next: { repoId: string; newSessions: number } | null;
  running: {
    repoId: string;
    startedAt: number;
    step: 'reading' | 'checking';
  } | null;
  switchedOff: DreamSwitchedOff | null;
  repos: {
    id: string;
    name: string;
    /** The folders a dream may change, prefilled for a repo that is not set up yet. */
    suggestedFolders: string[];
    /** Sessions waiting to be dreamt about, as far as the scheduler read them (0 when not read yet). */
    newSessions: number;
    state: DreamRepoState;
  }[];
  /** Newest first. */
  journal: DreamJournalEntry[];
};
