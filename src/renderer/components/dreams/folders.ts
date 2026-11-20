import { DreamRepoSchema, isProtectedPath } from '../../../shared/dreams';

const folderSchema = DreamRepoSchema.shape.folders.element;

/** Why a folder a dream may change is refused, in words; null when it is fine. Uses the schema main saves with. */
export function folderProblem(value: string): string | null {
  const f = value.trim();
  if (f === '') return 'Type a folder or file inside the repo.';
  if (folderSchema.safeParse(f).success) return null;
  if (f.startsWith('/') || /^[A-Za-z]:/.test(f))
    return 'Use a path inside the repo, not an absolute one.';
  if (f.includes('\\')) return 'Use forward slashes, as in docs/rules.';
  const segments = f.split('/');
  if (segments.includes('..'))
    return 'A path may not go up with "..": it must stay inside the repo.';
  if (f === '.' || segments.includes('.'))
    return 'Name a folder or file inside the repo: "." would be the whole repo.';
  if (isProtectedPath(f))
    return "A dream never changes OpenCode's own configuration or a hooks folder.";
  return 'Use a path inside the repo, such as .apm or AGENTS.md.';
}

/** Digits with spaces or dots as separators: the number, or null. */
export function parseTokens(text: string): number | null {
  const t = text.trim();
  if (!/^\d+([ . ]\d+)*$/.test(t)) return null;
  const n = Number(t.replace(/[ . ]/g, ''));
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** 5000000 as "5 000 000". */
export const spacedNumber = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
