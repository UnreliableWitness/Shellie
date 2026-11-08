import {
  ChevronDown16Regular,
  ChevronRight16Regular,
} from '@fluentui/react-icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BrainChapter } from '../../../shared/brain';
import { local } from '../../localStorage';
import type { TreeGroup, TreeItem } from './brainTree';

export type TreeSpecial = 'recent' | 'log';

/** The book in the tree: its numbered chapters, the open one listing its pages. */
export type TreeBook = {
  chapters: BrainChapter[];
  /** The chapter shown, or -1. */
  openChapter: number;
  titleOf: (path: string) => string;
  onOpenChapter: (n: number) => void;
};

const START = 'start';
const UNPLACED = 'unplaced';
/** Collapsed when nothing is stored yet: the sources can run long. */
const DEFAULT_COLLAPSED = ['sources'];

function readCollapsed(key: string): Set<string> {
  try {
    const raw = local()?.getItem(key);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed))
        return new Set(parsed.filter((k) => typeof k === 'string'));
    }
  } catch {
    /* no storage or a bad value: the default */
  }
  return new Set(DEFAULT_COLLAPSED);
}

function writeCollapsed(key: string, collapsed: Set<string>) {
  try {
    local()?.setItem(key, JSON.stringify([...collapsed]));
  } catch {
    /* no storage: not remembered */
  }
}

const groupKey = (parent: string | null, key: string) =>
  parent ? `${parent}/${key}` : key;
const countOf = (g: TreeGroup): number =>
  g.items.length + (g.subgroups ?? []).reduce((n, s) => n + countOf(s), 0);

/** The keys of the group and subgroups that hold `path`, outermost first. */
function keysHolding(
  groups: TreeGroup[],
  path: string,
  parent: string | null = null,
): string[] {
  for (const g of groups) {
    const key = groupKey(parent, g.key);
    if (g.items.some((i) => i.path === path)) return [key];
    const inner = keysHolding(g.subgroups ?? [], path, key);
    if (inner.length) return [key, ...inner];
  }
  return [];
}

function Item({
  label,
  current,
  isNew,
  title,
  onClick,
}: {
  label: string;
  current: boolean;
  isNew?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="brain-tree-item"
        title={title}
        aria-current={current ? 'page' : undefined}
        onClick={onClick}
      >
        {label}
        {isNew && <span className="brain-dot" role="img" aria-label="new" />}
      </button>
    </li>
  );
}

/**
 * The Read view's tree: Start here (pinned pages and Recent changes), a collapsible group per page type and the
 * sources, then Log. The collapsed groups are remembered under `collapsedKey`; the group holding `current` opens.
 * With a `book`, Start here is replaced by The book (numbered chapters), then `groups` as Back of the book and Not
 * placed yet when `unplaced` has pages, then Recent changes and Log.
 */
export function BrainTree({
  groups,
  start,
  current,
  newPaths,
  onOpen,
  onOpenSpecial,
  collapsedKey,
  book,
  unplaced = [],
}: {
  groups: TreeGroup[];
  start: TreeItem[];
  /** The open page's path, or the special view shown. */
  current: string | TreeSpecial | null;
  newPaths: Set<string>;
  onOpen: (path: string) => void;
  onOpenSpecial: (which: TreeSpecial) => void;
  /** The localStorage key the collapsed groups are stored under. */
  collapsedKey: string;
  book?: TreeBook;
  /** With a book: the pages in no chapter nor at the back of the book. */
  unplaced?: TreeItem[];
}) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(collapsedKey));
  const update = (next: Set<string>) => {
    setCollapsed(next);
    writeCollapsed(collapsedKey, next);
  };
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    update(next);
  };

  // The group holding a newly opened page opens, once: a group the reader collapses afterwards stays collapsed
  // when the brain changes (new `groups`).
  const expandedFor = useRef<string | null>(null);
  const unplacedGroup: TreeGroup = {
    key: UNPLACED,
    label: 'Not placed yet',
    items: unplaced,
  };
  useEffect(() => {
    if (!current || expandedFor.current === current) return;
    const holding = start.some((i) => i.path === current)
      ? [START]
      : keysHolding(
          unplaced.length ? [...groups, unplacedGroup] : groups,
          current,
        );
    // Not in the tree yet (pages still loading): try again when they arrive.
    if (!holding.length) return;
    expandedFor.current = current;
    if (!holding.some((k) => collapsed.has(k))) return;
    const next = new Set(collapsed);
    for (const k of holding) next.delete(k);
    update(next);
  });

  const item = (i: TreeItem) => (
    <Item
      key={i.path}
      label={i.label}
      title={i.path}
      current={current === i.path}
      isNew={newPaths.has(i.path)}
      onClick={() => onOpen(i.path)}
    />
  );
  const group = (
    key: string,
    label: string,
    count: number | null,
    body: ReactNode,
  ) => {
    const open = !collapsed.has(key);
    return (
      <li key={key} className="brain-tree-group">
        <button
          type="button"
          className="brain-tree-toggle"
          aria-expanded={open}
          onClick={() => toggle(key)}
        >
          <span className="brain-tree-caret" aria-hidden="true">
            {open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
          </span>
          {label}
          {count !== null && (
            <>
              {' '}
              <span className="brain-tree-count muted">{count}</span>
            </>
          )}
        </button>
        {open && (
          <ul className="brain-tree-list" aria-label={label}>
            {body}
          </ul>
        )}
      </li>
    );
  };
  const typed = (g: TreeGroup, parent: string | null): ReactNode => {
    const key = groupKey(parent, g.key);
    return group(
      key,
      g.label,
      countOf(g),
      <>
        {g.items.map(item)}
        {(g.subgroups ?? []).map((s) => typed(s, key))}
      </>,
    );
  };

  if (book)
    return (
      <ul className="brain-tree">
        <li>
          <h3 className="brain-tree-heading">The book</h3>
          <ul className="brain-tree-list brain-tree-book">
            {book.chapters.map((c, n) => {
              const open = n === book.openChapter;
              return (
                <li key={n}>
                  {c.pages.length ? (
                    <button
                      type="button"
                      className="brain-tree-item brain-tree-chapter"
                      aria-expanded={open}
                      onClick={() => book.onOpenChapter(n)}
                    >
                      <span className="brain-tree-num">{n + 1}</span>
                      {c.title}
                    </button>
                  ) : (
                    <span className="brain-tree-item brain-tree-chapter is-empty muted">
                      <span className="brain-tree-num">{n + 1}</span>
                      {c.title}
                    </span>
                  )}
                  {open && (
                    <ul className="brain-tree-list" aria-label={c.title}>
                      {c.pages.map((p) =>
                        item({ path: p, label: book.titleOf(p) }),
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
        {groups.length > 0 && (
          <li>
            <h3 className="brain-tree-heading">Back of the book</h3>
            <ul className="brain-tree-list">
              {groups.map((g) => typed(g, null))}
            </ul>
          </li>
        )}
        {unplaced.length > 0 && typed(unplacedGroup, null)}
        <Item
          label="Recent changes"
          current={current === 'recent'}
          onClick={() => onOpenSpecial('recent')}
        />
        <Item
          label="Log"
          current={current === 'log'}
          onClick={() => onOpenSpecial('log')}
        />
      </ul>
    );

  return (
    <ul className="brain-tree">
      {group(
        START,
        'Start here',
        null,
        <>
          {start.map(item)}
          <Item
            label="Recent changes"
            current={current === 'recent'}
            onClick={() => onOpenSpecial('recent')}
          />
        </>,
      )}
      {groups.map((g) => typed(g, null))}
      <Item
        label="Log"
        current={current === 'log'}
        onClick={() => onOpenSpecial('log')}
      />
    </ul>
  );
}
