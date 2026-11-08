import {
  BRAIN_PAGE_TYPES,
  SourceTypeSchema,
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
