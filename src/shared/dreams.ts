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

/** Repo-relative, forward slashes, no `..` segment, not absolute, not empty. */
const DreamFolderSchema = z
  .string()
  .min(1)
  .refine(
    (f) =>
      !f.startsWith('/') &&
      !f.includes('\\') &&
      !/^[A-Za-z]:/.test(f) &&
      !f.split('/').includes('..'),
    'a repo-relative folder with forward slashes and no ..',
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
