/**
 * What a dream's agent writes to `<dataDir>/report.json`, and how Shellie finishes a run from it. Everything in the
 * report was written by a model that read untrusted session text, so the schema bounds every field.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isProtectedPath, type DreamProposalKind } from '../../shared/dreams';

const KINDS = [
  'new-rule',
  'changed-rule',
  'new-skill',
  'changed-skill',
  'new-agent',
  'changed-agent',
] as const satisfies readonly DreamProposalKind[];

/** At most this many proposals are kept; the prompt asks for no more. */
const MAX_KEPT = 3;

const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
/** Forward slashes, no leading `./`. */
const normalise = (p: string): string =>
  p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

const line = (max: number) => z.string().max(max).transform(oneLine);

const FileSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (f) =>
      !f.startsWith('/') &&
      !f.startsWith('\\') &&
      !/^[A-Za-z]:/.test(f) &&
      !f.split(/[\\/]/).includes('..'),
    'a repo-relative path without ..',
  )
  .transform(normalise);

const EvidenceSchema = z.object({
  task: line(200),
  date: line(100),
  quote: z.string().max(500),
});

const ProposalSchema = z.object({
  kind: z.enum(KINDS),
  title: line(200),
  why: z.string().max(1000),
  evidence: z.array(EvidenceSchema).max(10),
  files: z.array(FileSchema).max(50),
  verdict: z.enum(['pass', 'fail']).optional(),
  verdictWhy: z.string().max(1000).optional(),
});

export const DreamReportSchema = z.object({
  proposals: z.array(ProposalSchema).max(10),
  sightings: z
    .array(
      z.object({
        note: line(500),
        task: line(200),
        quote: z.string().max(500),
      }),
    )
    .max(50),
});
export type DreamReport = z.infer<typeof DreamReportSchema>;

/** Reads `<dataDir>/report.json`; a missing, unparsable or misshapen file is the same error. */
export async function readReport(dataDir: string): Promise<DreamReport> {
  const failure = new Error('The dream left no readable report');
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dataDir, 'report.json'), 'utf8');
  } catch {
    throw failure;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw failure;
  }
  const parsed = DreamReportSchema.safeParse(json);
  if (!parsed.success) throw failure;
  return parsed.data;
}

/**
 * Splits changed paths into those inside an allowed folder and those outside. A folder `a/b` allows `a/b` and
 * `a/b/**`, not `a/bc`. Paths are compared exactly (git paths are case-sensitive) after separators become `/` and a
 * leading `./` goes. OpenCode's own configuration is always outside, whatever folder holds it. Returned paths are the
 * normalised ones.
 */
export function splitAllowed(
  changed: string[],
  folders: string[],
): { allowed: string[]; outside: string[] } {
  const roots = folders.map((f) => normalise(f).replace(/\/+$/, ''));
  const allowed: string[] = [];
  const outside: string[] = [];
  for (const c of changed) {
    const p = normalise(c);
    const escapes = p.startsWith('/') || p.split('/').includes('..');
    const inside =
      !escapes &&
      !isProtectedPath(p) &&
      roots.some(
        (r) => r === '' || r === '.' || p === r || p.startsWith(`${r}/`),
      );
    (inside ? allowed : outside).push(p);
  }
  return { allowed, outside };
}

type Proposal = DreamReport['proposals'][number];
export interface DreamGroup {
  kind: DreamProposalKind;
  title: string;
  why: string;
  evidence: Proposal['evidence'];
  files: string[];
}

/**
 * What to commit: one group per passing proposal, in report order, at most 3. Proposals sharing a file become one
 * (titles joined with " + ", the first one's kind). Files a proposal lists that did not change are dropped from it; a
 * proposal left with no file is removed. Allowed changed files no group lists are `unlisted` (to be reverted).
 * `removedByCheck` counts the proposals that did not make it. A proposal without a verdict counts as failed once a
 * check run happened (`checked`, by default: any proposal has a verdict).
 */
export function groupProposals(
  report: DreamReport,
  allowedChanged: string[],
  checked: boolean = report.proposals.some((p) => p.verdict !== undefined),
): { groups: DreamGroup[]; unlisted: string[]; removedByCheck: number } {
  const changed = new Set(allowedChanged.map(normalise));
  let removed = 0;
  const kept: DreamGroup[] = [];
  for (const p of report.proposals) {
    const passes = checked ? p.verdict === 'pass' : p.verdict !== 'fail';
    const files = [...new Set(p.files)].filter((f) => changed.has(f));
    if (!passes || files.length === 0 || kept.length >= MAX_KEPT) {
      removed += 1;
      continue;
    }
    kept.push({
      kind: p.kind,
      title: p.title,
      why: p.why,
      evidence: p.evidence,
      files,
    });
  }

  const groups: DreamGroup[] = [];
  for (const g of kept) {
    const at = groups.findIndex((o) =>
      o.files.some((f) => g.files.includes(f)),
    );
    if (at === -1) {
      groups.push(g);
      continue;
    }
    const o = groups[at];
    groups[at] = {
      kind: o.kind,
      title: `${o.title} + ${g.title}`,
      why: `${o.why} ${g.why}`.trim(),
      evidence: [...o.evidence, ...g.evidence],
      files: [...new Set([...o.files, ...g.files])],
    };
  }

  const listed = new Set(groups.flatMap((g) => g.files));
  const unlisted = [...changed].filter((f) => !listed.has(f));
  return { groups, unlisted, removedByCheck: removed };
}
