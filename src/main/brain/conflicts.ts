import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  CONFLICT_KINDS,
  conflictIdOf,
  conflictOf,
  SettleDecisionSchema,
  type BrainConflictRow,
  type BrainConflicts,
  type BrainFinding,
  type ConflictKind,
} from '../../shared/brain';
import { writeAtomic } from '../fsRetry';

const ConflictsFileSchema = z.object({
  version: z.literal(1),
  conflicts: z.record(
    z.string(),
    z.object({
      parked: z.object({ question: z.string(), at: z.string() }).optional(),
      settled: z
        .object({
          at: z.string(),
          status: z.enum(['pending', 'done', 'failed']),
          decision: SettleDecisionSchema,
          page: z.string().nullable(),
          error: z.string().nullable(),
        })
        .optional(),
    }),
  ),
});
/** brain/conflicts.json: what the person did with each conflict (parked, or settled with the whole decision). Shellie's only. */
export type ConflictsFile = z.infer<typeof ConflictsFileSchema>;

export const EMPTY_CONFLICTS: ConflictsFile = { version: 1, conflicts: {} };

/** Settles shown in the list for this long. */
const SETTLED_DAYS = 30;

const fileOf = (dir: string) => path.join(dir, 'brain', 'conflicts.json');

/** The brain's conflicts file; missing or unreadable reads as empty (nothing parked or settled). */
export async function readConflicts(dir: string): Promise<ConflictsFile> {
  try {
    const r = ConflictsFileSchema.safeParse(
      JSON.parse(await readFile(fileOf(dir), 'utf8')),
    );
    return r.success ? r.data : EMPTY_CONFLICTS;
  } catch {
    return EMPTY_CONFLICTS;
  }
}

// One write at a time per brain folder: a park and a settle at once must both land.
const queues = new Map<string, Promise<unknown>>();

/** Changes the conflicts file atomically, one change at a time per brain folder. */
export function updateConflicts(
  dir: string,
  change: (f: ConflictsFile) => ConflictsFile,
): Promise<ConflictsFile> {
  const run = (queues.get(dir) ?? Promise.resolve()).then(async () => {
    const next = ConflictsFileSchema.parse(change(await readConflicts(dir)));
    await writeAtomic(
      fileOf(dir),
      `${JSON.stringify(next, null, 2)}\n`,
      `.${process.pid}.tmp`,
    );
    return next;
  });
  queues.set(
    dir,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * Lint's contradictions and scope changes against what the person did: open ones (newest first), parked ones,
 * the settles of the last 30 days, and the answer sources of settles not done yet. A settled conflict stays hidden
 * unless lint marked it `reopens`.
 */
export function listConflicts(
  findings: BrainFinding[],
  file: ConflictsFile,
  now: Date,
): BrainConflicts {
  const open: BrainConflicts['open'] = [];
  const parked: BrainConflicts['parked'] = [];
  const seen = new Set<string>();
  const byNewest = [...findings].sort((a, b) => b.at.localeCompare(a.at));
  for (const f of byNewest) {
    if (!CONFLICT_KINDS.has(f.kind)) continue;
    const id = conflictIdOf(f);
    if (seen.has(id)) continue;
    seen.add(id);
    const conflict = conflictOf(f);
    const row: BrainConflictRow = {
      id,
      kind: f.kind as ConflictKind,
      page: f.page,
      detail: f.detail,
      at: f.at,
      conflict,
    };
    const rec = file.conflicts[id];
    if (rec?.settled && !conflict?.reopens) continue;
    if (rec?.parked)
      parked.push({
        ...row,
        question: rec.parked.question,
        parkedAt: rec.parked.at,
      });
    else open.push(row);
  }
  const since = now.getTime() - SETTLED_DAYS * 86_400_000;
  const settledRecs = Object.entries(file.conflicts)
    .flatMap(([id, r]) => (r.settled ? [{ id, s: r.settled }] : []))
    .sort((a, b) => b.s.at.localeCompare(a.s.at));
  return {
    open,
    parked,
    settled: settledRecs
      .filter(({ s }) => Date.parse(s.at) >= since)
      .map(({ id, s }) => ({
        id,
        question: s.decision.question,
        choice: s.decision.choice,
        text: s.decision.text,
        at: s.at,
        status: s.status,
        page: s.page,
        error: s.error,
      })),
    answers: settledRecs.flatMap(({ s }) =>
      s.status !== 'done' && s.decision.answer ? [s.decision.answer] : [],
    ),
  };
}
