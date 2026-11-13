import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BrainFinding,
  BrainHealth,
  PictureCounts,
  SourcePictures,
} from '../../shared/brain';
import { CONFLICT_KINDS, conflictIdOf } from '../../shared/brain';
import type { CostRecord } from '../../shared/ledger';
import type { GitClient } from '../services/GitClient';
import { checkBrain, SHELLIE_FINDING_KINDS } from './check';
import { listConflicts, readConflicts } from './conflicts';
import { readPages } from './pages';
import { brainCoverage, pictureFindings } from './pictures';
import { listSources } from './sources';
import { readState } from './state';

/** Commits Shellie makes in a brain: 'Brain: …', and the scaffold's first one. */
const isBrainCommit = (subject: string) =>
  subject.startsWith('Brain:') || subject === 'Brain created';
/** A /sync run: it reconciles the human edits in wiki/ made before it. */
export const isSyncCommit = (subject: string) =>
  subject === 'Brain: sync' || subject.startsWith('Brain: sync ');

const SUBJECT = '\u0001';
/** Non-ASCII page names as they are, not octal-quoted. */
const RAW = ['-c', 'core.quotepath=off'];

/**
 * Files under wiki/ changed by commits other than Shellie's since the last /sync commit (or the whole history when
 * there is none), plus uncommitted changes there. Outside edits a job start commits ('Edited outside a capture')
 * stay listed until a /sync.
 */
export async function outsideEdits(brainDir: string, git: GitClient) {
  const found = new Set<string>();
  const log = await git
    .run(brainDir, [
      ...RAW,
      'log',
      `--format=${SUBJECT}%s`,
      '--name-only',
      '--',
      'wiki/',
    ])
    .catch(() => '');
  // Newest first: stop at the first sync.
  for (const block of log.split(SUBJECT).slice(1)) {
    const [subject, ...files] = block.split('\n');
    if (isSyncCommit(subject)) break;
    if (isBrainCommit(subject)) continue;
    for (const f of files) if (f.trim()) found.add(f.trim());
  }
  // No optional locks: Health must never hold .git/index.lock while a job or source commits.
  // -z: NUL-separated records with the path as it is (never quoted); a rename record is followed by the old path.
  const status = await git
    .run(brainDir, [
      '--no-optional-locks',
      ...RAW,
      'status',
      '--porcelain',
      '-z',
      '-uall',
      '--',
      'wiki/',
    ])
    .catch(() => '');
  const records = status.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.length < 4) continue;
    found.add(r.slice(3));
    if (r[0] === 'R' || r[0] === 'C') i++;
  }
  return [...found].sort();
}

/** The lint's findings worth showing: the kinds Shellie does not compute itself (its live result replaces those). */
const lintFindings = (findings: BrainFinding[]): BrainFinding[] =>
  findings.filter(
    (f) => !SHELLIE_FINDING_KINDS.has(f.kind) && f.kind !== 'orphan',
  );

/** The picture counts of all sources added up. */
function sumPictures(all: SourcePictures[]): PictureCounts {
  const sum: PictureCounts = {
    total: 0,
    described: 0,
    skipped: 0,
    missing: 0,
    dropped: 0,
    accepted: 0,
    tiny: 0,
  };
  for (const { counts } of all)
    for (const k of Object.keys(sum) as (keyof PictureCounts)[])
      sum[k] += counts[k];
  return sum;
}

export async function brainHealth(
  brainDir: string,
  git: GitClient,
  ledgerToday: { tokens: number; costEur: number },
  queuePaused: boolean,
  now: Date = new Date(),
  /** Sources with a capture queued or running (not uncaptured). */
  inFlight: string[] = [],
  /** The runner holds the queue until Update skills (an OpenCode brain on old skills). */
  queueHeld = false,
): Promise<BrainHealth> {
  const { state, error } = await readState(brainDir);
  // Parked and settled conflicts are not findings to act on; a pending settle's answer is in flight, not uncaptured.
  const conflicts = listConflicts(
    state?.findings ?? [],
    await readConflicts(brainDir),
    now,
  );
  const open = new Set(conflicts.open.map((c) => c.id));
  const answers = new Set(conflicts.answers);
  const busy = [...inFlight, ...conflicts.answers];
  const [sources, edits, pages, indexMd] = await Promise.all([
    listSources(brainDir, state).catch(() => []),
    outsideEdits(brainDir, git),
    readPages(brainDir).catch(() => []),
    fs.readFile(path.join(brainDir, 'index.md'), 'utf8').catch(() => null),
  ]);
  const [own, pictures] = await Promise.all([
    checkBrain(
      { brainDir, pages, sources, indexMd, inFlight: busy },
      now,
    ).catch(() => []),
    // Directory listings and the source texts only: no picture is read.
    // Health only counts: no source is read for alt texts.
    brainCoverage(brainDir, pages, sources, { alt: false }).catch(() => []),
  ]);
  const mirror = sources.filter((s) => s.path.startsWith('sources/wiki/'));
  return {
    state,
    stateError: error,
    findings: [
      ...own,
      ...pictureFindings(pictures, now.toISOString()),
      ...lintFindings(state?.findings ?? []).filter(
        (f) => !CONFLICT_KINDS.has(f.kind) || open.has(conflictIdOf(f)),
      ),
    ],
    pages: pages.length,
    uncaptured: sources.filter(
      (s) =>
        !s.captured &&
        !s.path.startsWith('sources/wiki/') &&
        !answers.has(s.path),
    ).length,
    mirrorPages: mirror.length,
    outsideEdits: edits,
    queuePaused: queuePaused ? 'cap' : null,
    queueHeld: queueHeld ? 'Update skills to run on OpenCode' : null,
    costEurToday: ledgerToday.costEur,
    tokensToday: ledgerToday.tokens,
    pictures: sumPictures(pictures),
  };
}

const localDay = (d: Date) =>
  `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** The brain's ledger records of today's local date: all tokens (cache included) and the euros that are priced. */
export function ledgerToday(
  records: CostRecord[],
  brainId: string,
  now: Date = new Date(),
): { tokens: number; costEur: number } {
  const today = localDay(now);
  let tokens = 0;
  let costEur = 0;
  for (const r of records) {
    if (r.attribution.level !== 'brain' || r.attribution.brainId !== brainId)
      continue;
    if (localDay(new Date(r.at)) !== today) continue;
    tokens +=
      r.inputTokens +
      r.outputTokens +
      r.cacheReadTokens +
      r.cacheWrite5mTokens +
      r.cacheWrite1hTokens;
    costEur += r.costEur ?? 0;
  }
  return { tokens, costEur };
}
