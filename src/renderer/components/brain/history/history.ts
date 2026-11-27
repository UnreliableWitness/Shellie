import type { BrainActivityEntry } from '../../../../shared/brainShare';
import { plural } from '../../../../shared/text';

/** How many commits a brain remembers as seen: more than one list holds. */
const SEEN_KEPT = 600;

/**
 * The entries colleagues made that this person has not seen yet. `seen` null (the first look at this brain): none,
 * so a brain just joined does not announce its whole past.
 */
export function unseenFromColleagues(
  entries: BrainActivityEntry[],
  seen: ReadonlySet<string> | null,
): BrainActivityEntry[] {
  if (!seen) return [];
  return entries.filter((e) => !e.me && !seen.has(e.id));
}

/** `seen` with these entries added, newest first, capped. */
export function withSeen(
  entries: BrainActivityEntry[],
  seen: ReadonlySet<string> | null,
): string[] {
  const all = new Set(entries.map((e) => e.id));
  for (const id of seen ?? []) all.add(id);
  return [...all].slice(0, SEEN_KEPT);
}

/** "Anna", "Anna and Bert", "Anna and 2 others". */
export function names(entries: BrainActivityEntry[]): string {
  const who = [...new Set(entries.map((e) => e.who))];
  if (who.length <= 1) return who[0] ?? 'A colleague';
  if (who.length === 2) return `${who[0]} and ${who[1]}`;
  return `${who[0]} and ${who.length - 1} others`;
}

const count = (entries: BrainActivityEntry[]) => {
  const pages = new Set<string>();
  let more = 0;
  let sources = 0;
  for (const e of entries) {
    for (const p of e.pages) pages.add(p.path);
    more += e.morePages;
    if (e.kind === 'source') sources++;
  }
  return { pages: pages.size + more, sources };
};

/** What colleagues brought, in one line: "Anna added 3 pages". */
export function arrivedText(entries: BrainActivityEntry[]): string {
  const who = names(entries);
  const { pages, sources } = count(entries);
  if (pages > 0) return `${who} added ${plural(pages, 'page')}`;
  if (sources > 0) return `${who} added ${plural(sources, 'source')}`;
  if (entries.every((e) => e.kind === 'joined')) return `${who} joined`;
  return `${who} changed the brain`;
}

export type PersonWeek = {
  who: string;
  me: boolean;
  sources: number;
  pages: number;
};

/** Per person, what they added since `since`: this machine's person first, then the busiest. */
export function perPerson(
  entries: BrainActivityEntry[],
  since: number,
): PersonWeek[] {
  const by = new Map<string, BrainActivityEntry[]>();
  for (const e of entries) {
    if (Date.parse(e.at) < since) continue;
    const key = e.me ? '' : e.who;
    by.set(key, [...(by.get(key) ?? []), e]);
  }
  return [...by.entries()]
    .map(([key, list]) => ({
      who: key === '' ? 'You' : key,
      me: key === '',
      ...count(list),
    }))
    .filter((p) => p.sources + p.pages > 0)
    .sort(
      (a, b) =>
        Number(b.me) - Number(a.me) ||
        b.pages + b.sources - (a.pages + a.sources),
    );
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** The entries under their day: "Today", "Yesterday", else a date such as "Mon 23 Nov". */
export function byDay(
  entries: BrainActivityEntry[],
  now = new Date(),
): { day: string; entries: BrainActivityEntry[] }[] {
  const today = dayKey(now);
  const yesterday = dayKey(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
  );
  const days: { key: string; day: string; entries: BrainActivityEntry[] }[] =
    [];
  for (const e of entries) {
    const d = new Date(e.at);
    const key = dayKey(d);
    const last = days[days.length - 1];
    if (last?.key === key) {
      last.entries.push(e);
      continue;
    }
    days.push({
      key,
      day:
        key === today
          ? 'Today'
          : key === yesterday
            ? 'Yesterday'
            : d.toLocaleDateString('en-GB', {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                ...(d.getFullYear() === now.getFullYear()
                  ? {}
                  : { year: 'numeric' }),
              }),
      entries: [e],
    });
  }
  return days.map(({ day, entries: list }) => ({ day, entries: list }));
}

/** A page's name from its path when its title is not known: "wiki/api-keys.md" is "api keys". */
export const pageName = (path: string): string =>
  path
    .slice(path.lastIndexOf('/') + 1)
    .replace(/\.md$/, '')
    .replace(/[-_]+/g, ' ');
