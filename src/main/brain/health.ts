import type { BrainHealth } from '../../shared/brain';
import type { CostRecord } from '../../shared/ledger';
import type { GitClient } from '../services/GitClient';
import { listSources } from './sources';
import { readState } from './state';

/** Commits Shellie makes in a brain: 'Brain: …', and the scaffold's first one. */
const isBrainCommit = (subject: string) =>
  subject.startsWith('Brain:') || subject === 'Brain created';

const SUBJECT = '\u0001';
/** Non-ASCII page names as they are, not octal-quoted. */
const RAW = ['-c', 'core.quotepath=off'];

/**
 * Files under wiki/ changed by commits since the last Brain commit that touched wiki/ (or the whole history when
 * there is none), plus uncommitted changes there.
 */
async function outsideEdits(brainDir: string, git: GitClient) {
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
  // Newest first: stop at the first Brain commit.
  for (const block of log.split(SUBJECT).slice(1)) {
    const [subject, ...files] = block.split('\n');
    if (isBrainCommit(subject)) break;
    for (const f of files) if (f.trim()) found.add(f.trim());
  }
  const status = await git
    .run(brainDir, [...RAW, 'status', '--porcelain', '-uall', '--', 'wiki/'])
    .catch(() => '');
  for (const line of status.split('\n')) {
    if (line.length < 4) continue;
    const p = line.slice(3);
    // A rename shows as 'old -> new'.
    found.add(p.includes(' -> ') ? p.split(' -> ')[1] : p);
  }
  return [...found].sort();
}

export async function brainHealth(
  brainDir: string,
  git: GitClient,
  ledgerToday: { tokens: number; costEur: number },
  queuePaused: boolean,
): Promise<BrainHealth> {
  const { state, error } = await readState(brainDir);
  const [sources, edits] = await Promise.all([
    listSources(brainDir, state).catch(() => []),
    outsideEdits(brainDir, git),
  ]);
  const mirror = sources.filter((s) => s.path.startsWith('sources/wiki/'));
  return {
    state,
    stateError: error,
    uncaptured: sources.filter(
      (s) => !s.captured && !s.path.startsWith('sources/wiki/'),
    ).length,
    mirrorPages: mirror.length,
    outsideEdits: edits,
    queuePaused: queuePaused ? 'cap' : null,
    costEurToday: ledgerToday.costEur,
    tokensToday: ledgerToday.tokens,
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
