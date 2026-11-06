import { useEffect, useState, type ReactNode } from 'react';
import { local } from '../../localStorage';
import type { TreeGroup, TreeItem } from './brainTree';

export type TreeSpecial = 'recent' | 'log';

const START = 'start';
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
 */
export function BrainTree({
  groups,
  start,
  current,
  newPaths,
  onOpen,
  onOpenSpecial,
  collapsedKey,
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

  // The group holding the open page opens (and stays open).
  useEffect(() => {
    if (!current) return;
    const holding = start.some((i) => i.path === current)
      ? [START]
      : keysHolding(groups, current);
    setCollapsed((prev) => {
      if (!holding.some((k) => prev.has(k))) return prev;
      const next = new Set(prev);
      for (const k of holding) next.delete(k);
      writeCollapsed(collapsedKey, next);
      return next;
    });
  }, [current, groups, start, collapsedKey]);

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
            {open ? '▾' : '▸'}
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
