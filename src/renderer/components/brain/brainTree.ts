import {
  BACK_OF_BOOK_TYPES,
  BRAIN_PAGE_TYPES,
  SourceTypeSchema,
  type BrainBook,
  type BrainPageRow,
  type BrainPageType,
  type BrainSourceRow,
} from '../../../shared/brain';
import { sourceLabel } from './recent';

export type TreeItem = { path: string; label: string };
export type TreeGroup = {
  key: string;
  label: string;
  items: TreeItem[];
  subgroups?: TreeGroup[];
};

const TYPE_LABELS: Record<BrainPageType, string> = {
  subject: 'Subjects',
  account: 'Accounts',
  scope: 'Scope',
  component: 'Components',
  glossary: 'Glossary',
  decision: 'Decisions',
  meeting: 'Meetings',
  lesson: 'Lessons',
  digest: 'Digests',
  other: 'Other',
};

const WIKI_MIRROR = 'sources/wiki/';

/** The pages pinned on the front: the account and scope pages, then only the latest digest. */
export function pinnedPages(rows: BrainPageRow[]): BrainPageRow[] {
  const account = rows.filter((r) => r.type === 'account');
  const scope = rows.filter((r) => r.type === 'scope');
  const digests = rows.filter((r) => r.type === 'digest');
  const latest = digests.length
    ? [digests.reduce((a, b) => (a.path > b.path ? a : b))]
    : [];
  return [...account, ...scope, ...latest];
}

/** The Read tree's page groups: one per page type that has pages, in the front page's order. */
export function pageGroups(rows: BrainPageRow[]): TreeGroup[] {
  return BRAIN_PAGE_TYPES.flatMap((type) => {
    const items = rows
      .filter((r) => r.type === type)
      .map((r) => ({ path: r.path, label: r.title }));
    return items.length ? [{ key: type, label: TYPE_LABELS[type], items }] : [];
  });
}

const toItem = (s: BrainSourceRow): TreeItem => ({
  path: s.path,
  label: sourceLabel(s.path),
});

/** The Read tree's Sources group: a subgroup per source type, then the DevOps wiki mirror; null without sources. */
export function sourceGroup(sources: BrainSourceRow[]): TreeGroup | null {
  const own = sources.filter((s) => !s.path.startsWith(WIKI_MIRROR));
  const mirror = sources.filter((s) => s.path.startsWith(WIKI_MIRROR));
  const subgroups: TreeGroup[] = SourceTypeSchema.options.flatMap((type) => {
    const items = own.filter((s) => s.type === type).map(toItem);
    return items.length ? [{ key: type, label: type, items }] : [];
  });
  if (mirror.length)
    subgroups.push({
      key: 'wiki-mirror',
      label: 'DevOps wiki',
      items: mirror.map(toItem),
    });
  if (!subgroups.length) return null;
  return { key: 'sources', label: 'Sources', items: [], subgroups };
}

/** The back of the book's page groups, in reading order; the digests are the weekly ones. */
const BACK_GROUPS: [BrainPageType, string][] = [
  ['decision', 'Decisions'],
  ['meeting', 'Meetings'],
  ['digest', 'Weekly digests'],
  ['lesson', 'Lessons'],
  ['glossary', 'Glossary'],
];

/** The tree's Back of the book: a group per kind of reference page that has pages, then the sources. */
export function backOfBook(
  rows: BrainPageRow[],
  sources: BrainSourceRow[],
): TreeGroup[] {
  const groups = BACK_GROUPS.flatMap(([type, label]) => {
    const items = rows
      .filter((r) => r.type === type)
      .map((r) => ({ path: r.path, label: r.title }));
    return items.length ? [{ key: type, label, items }] : [];
  });
  const src = sourceGroup(sources);
  return src ? [...groups, src] : groups;
}

/** The pages in no chapter that are not back-of-the-book pages either: the ones the book would otherwise hide. */
export function unplaced(rows: BrainPageRow[], book: BrainBook): TreeItem[] {
  const placed = new Set(book.chapters.flatMap((c) => c.pages));
  return rows
    .filter((r) => !placed.has(r.path) && !BACK_OF_BOOK_TYPES.has(r.type))
    .map((r) => ({ path: r.path, label: r.title }));
}
