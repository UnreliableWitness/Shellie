/**
 * A brain's history as people read it: who added, wrote or changed what, read from the brain's own git log. Shellie's
 * housekeeping commits (the index, merges, shared facts, verified stamps) and job commits that touched no page are
 * left out.
 */
import {
  ACTIVITY_PAGES,
  type BrainActivityEntry,
  type BrainActivityKind,
} from '../../shared/brainShare';
import type { GitClient } from '../services/GitClient';
import {
  CREATED_MESSAGE,
  JOIN_MESSAGE,
  LEAVE_MESSAGE,
  parseJobSubject,
  SCRUB_MESSAGE,
  SHARE_MESSAGE,
  SQUASH_MESSAGE,
} from './brainCommits';
import { OUTSIDE_EDIT_MESSAGE } from './scrub';

const RECORD = '\x1e';
const FIELD = '\x1f';
/** Commits read for one list: most are housekeeping, so many more than the entries kept. */
const READ = 600;
export const ACTIVITY_LIMIT = 150;

const PEOPLE: ReadonlySet<BrainActivityKind> = new Set([
  'created',
  'shared',
  'joined',
  'left',
]);

const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

/** A page people read: a wiki page or a long read, not the index, the log or the wiki mirror's raw files. */
const isPage = (rel: string) =>
  rel.endsWith('.md') &&
  (rel.startsWith('wiki/') || rel.startsWith('reads/')) &&
  rel !== 'wiki/index.md';

type Kinded = { kind: BrainActivityKind; subject: string | null } | null;

/** What a commit is, by its subject; null for housekeeping. `pages`: whether it touched a page. */
function kindOf(subject: string, pages: boolean, sources: boolean): Kinded {
  const s = subject.trim();
  const fixed: Record<string, BrainActivityKind> = {
    [CREATED_MESSAGE]: 'created',
    [SHARE_MESSAGE]: 'shared',
    [JOIN_MESSAGE]: 'joined',
    [LEAVE_MESSAGE]: 'left',
    [SCRUB_MESSAGE]: 'scrubbed',
    [OUTSIDE_EDIT_MESSAGE]: 'edited',
    [SQUASH_MESSAGE]: 'changed',
    'Brain: settle conflict': 'settled',
    'Brain: answer to a conflict': 'answered',
  };
  if (fixed[s]) {
    const kind = fixed[s];
    // An edit or a fold that touched no page says nothing to a reader.
    return (kind === 'edited' || kind === 'changed') && !pages
      ? null
      : { kind, subject: null };
  }
  const added = /^Brain: add source (.+)$/.exec(s);
  if (added) return { kind: 'source', subject: baseName(added[1]) };
  const removed = /^Brain: remove source (.+)$/.exec(s);
  if (removed) return { kind: 'removed', subject: baseName(removed[1]) };
  const job = parseJobSubject(s);
  if (job) {
    if (job.kind === 'write')
      return {
        kind: 'wrote',
        subject: job.target ? baseName(job.target) : null,
      };
    if (job.kind === 'settle') return { kind: 'settled', subject: null };
    if (!pages) return null;
    if (job.kind === 'capture')
      return {
        kind: 'captured',
        subject: job.source ? baseName(job.source) : null,
      };
    if (job.kind === 'digest') return { kind: 'digest', subject: null };
    if (job.kind === 'sync' || job.kind === 'lint')
      return { kind: 'tidied', subject: null };
    return { kind: 'changed', subject: null };
  }
  if (s.startsWith('Brain:')) return null;
  // A commit Shellie did not make (someone used git by hand).
  return pages || sources ? { kind: 'edited', subject: null } : null;
}

/**
 * The brain's history, newest first. `installId`: this machine's commits in a shared brain carry it as their author
 * email; in a local brain (`null`) every commit is this person's.
 */
export async function brainActivity(
  git: GitClient,
  dir: string,
  o: { installId: string | null; limit?: number },
): Promise<BrainActivityEntry[]> {
  const out = await git
    .run(dir, [
      '-c',
      'core.quotepath=false',
      'log',
      '-n',
      String(READ),
      '--no-merges',
      '--no-renames',
      '--name-status',
      `--format=${RECORD}%H${FIELD}%aI${FIELD}%aN${FIELD}%aE${FIELD}%s`,
    ])
    .catch(() => '');
  const mine = o.installId ? `${o.installId}@install.shellie` : null;
  const entries: BrainActivityEntry[] = [];
  for (const record of out.split(RECORD)) {
    if (entries.length >= (o.limit ?? ACTIVITY_LIMIT)) break;
    const [head, ...lines] = record.split('\n');
    const [id, at, who, email, subject] = head.split(FIELD);
    if (!id || subject === undefined) continue;
    const pages: { path: string; added: boolean }[] = [];
    let sources = false;
    for (const line of lines) {
      const [status, rel] = line.split('\t');
      if (!rel) continue;
      if (rel.startsWith('sources/')) sources = true;
      if (status !== 'D' && isPage(rel))
        pages.push({ path: rel, added: status === 'A' });
    }
    const kind = kindOf(subject, pages.length > 0, sources);
    if (!kind) continue;
    // New pages first: they are the news.
    pages.sort((a, b) => Number(b.added) - Number(a.added));
    // A share is one commit of the whole brain, a join or a leave only the members list: no pages to name.
    const named = PEOPLE.has(kind.kind) ? [] : pages;
    entries.push({
      id,
      at,
      who,
      me: mine === null || email === mine,
      ...kind,
      pages: named.slice(0, ACTIVITY_PAGES),
      morePages: Math.max(0, named.length - ACTIVITY_PAGES),
    });
  }
  return entries;
}
