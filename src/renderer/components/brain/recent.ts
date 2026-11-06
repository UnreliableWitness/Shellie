import type { BrainJob, BrainPageRow } from '../../../shared/brain';

/** One log entry that names pages: `- <ISO> <skill> <source or ''> → pages: a, b; takeaway: …`. */
export type RecentEntry = {
  at: string;
  skill: string;
  /** What the entry names between the skill and `→`, trimmed; '' when nothing. */
  source: string;
  /** The `pages:` entries, each matched to a page when one is found. */
  pages: { label: string; path: string | null }[];
};

const LINE =
  /^-\s+(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(\S+)\s*(.*?)\s*(?:→|->)\s*pages:\s*([^;]*)/;

/** The page a log entry names: its path, its file stem, or its title (any case). */
export function matchPage(label: string, rows: BrainPageRow[]): string | null {
  const l = label.trim().replace(/^`|`$/g, '').toLowerCase();
  if (!l) return null;
  for (const r of rows) {
    const p = r.path.toLowerCase();
    const stem = p.replace(/^wiki\//, '').replace(/\.md$/, '');
    if (
      p === l ||
      p.endsWith(`/${l}`) ||
      stem === l ||
      stem.endsWith(`/${l}`) ||
      `${stem}.md` === l ||
      r.title.toLowerCase() === l
    )
      return r.path;
  }
  return null;
}

/** The first `max` entries of log.md that name pages, in file order (newest first as the schema prescribes). */
export function recentEntries(
  logText: string,
  rows: BrainPageRow[],
  max = 10,
): RecentEntry[] {
  const out: RecentEntry[] = [];
  for (const line of logText.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const pages = m[4]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((raw) => {
        // `[Title](wiki/x.md)` names the page by its path; a trailing period is punctuation.
        const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(raw);
        const label = (link ? link[1] : raw).replace(/\.$/, '');
        const key = (link ? link[2] : raw).replace(/\.$/, '');
        return { label, path: matchPage(key, rows) ?? matchPage(label, rows) };
      });
    if (!pages.length) continue;
    out.push({ at: m[1], skill: m[2], source: m[3].trim(), pages });
    if (out.length >= max) break;
  }
  return out;
}

/** The pages the capture `job` wrote: those of the newest `/capture` log entry for its source file that is not after the job's end; none for any other job. */
export function pagesChangedBy(
  job: BrainJob,
  logText: string,
  rows: BrainPageRow[],
): { label: string; path: string | null }[] {
  if (job.kind !== 'capture' || job.status !== 'done' || !job.source) return [];
  const file = job.source.split('/').pop();
  if (!file) return [];
  const entry = recentEntries(logText, rows, Infinity).find(
    (e) =>
      (e.skill === '/capture' || e.skill === 'capture') &&
      e.source.endsWith(file) &&
      !(job.endedAt && isAfter(e.at, job.endedAt)),
  );
  return entry ? entry.pages : [];
}

/** Whether `at` is after `since`: as instants when both parse, else as text. */
export function isAfter(at: string, since: string): boolean {
  const a = Date.parse(at);
  const b = Date.parse(since);
  return Number.isNaN(a) || Number.isNaN(b) ? at > since : a > b;
}

/** A `yyyy-mm-dd` day (or a timestamp) as "4 Nov" in the app's locale; the text as is when it is not a day. */
export function shortDay(day: string | null): string {
  if (!day) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

/** The chip text of a source path: the file name without its date prefix and extension. */
export function sourceLabel(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
}

/** Words of the breadcrumb: the folders between wiki/ and the file. */
export function folderOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(1, -1);
}
