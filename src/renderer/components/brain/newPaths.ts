import type { BrainPageRow } from '../../../shared/brain';
import { isAfter, recentEntries } from './recent';

/** The pages the log says were written after `since` (the last visit to the brain); none without a last visit. */
export function newPathsSince(
  log: string,
  rows: BrainPageRow[],
  since: string | null,
): Set<string> {
  const out = new Set<string>();
  if (!since) return out;
  for (const e of recentEntries(log, rows))
    if (isAfter(e.at, since))
      for (const p of e.pages) if (p.path) out.add(p.path);
  return out;
}
