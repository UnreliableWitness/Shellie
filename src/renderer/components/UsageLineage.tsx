import {
  ChevronDown12Regular,
  ChevronRight12Regular,
} from '@fluentui/react-icons';
import { useState } from 'react';
import type { UsageNode } from '../../shared/usage';
import { shortModelName } from '../../shared/usageViews';
import { compact, eur } from '../format';
import { modelColor } from '../modelColor';

const DOT = String.fromCharCode(0xb7);

const cost = (n: UsageNode): string =>
  n.unpricedRequests === n.requests
    ? 'unpriced'
    : `${eur(n.costEur)}${n.unpricedRequests > 0 ? ' + unpriced' : ''}`;

const share = (s: number): string =>
  s === 0 ? '' : s < 0.005 ? '<1%' : `${Math.round(s * 100)}%`;

/** The Usage tab's lineage: each session with the subagents it started, coloured by model family, sized by cost share. */
export function UsageLineage({
  nodes,
  rootName,
}: {
  nodes: UsageNode[];
  /** A session root's name (its tool and start), since its own label is empty. */
  rootName: (n: UsageNode) => string;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const total = nodes.reduce((n, r) => n + r.costEur, 0);
  const render = (n: UsageNode, level: number) => {
    const name = n.parentId === null ? rootName(n) : n.label;
    const open = !folded.has(n.id);
    const s = total > 0 ? n.costEur / total : 0;
    const color = modelColor(n.modelLabel || n.model);
    return (
      <li
        key={n.id}
        role="treeitem"
        aria-level={level}
        aria-expanded={n.children.length > 0 ? open : undefined}
        aria-label={name}
      >
        <div
          className="ul-row"
          style={{ paddingLeft: (level - 1) * 20 }}
          title={`${name} ${DOT} ${n.modelLabel} ${DOT} ${compact(n.tokens)} tokens ${DOT} ${n.requests} ${n.requests === 1 ? 'request' : 'requests'} ${DOT} ${cost(n)}`}
        >
          {n.children.length > 0 ? (
            <button
              type="button"
              className="ul-toggle"
              aria-label={open ? 'Hide subagents' : 'Show subagents'}
              onClick={() => toggle(n.id)}
            >
              {open ? (
                <ChevronDown12Regular aria-hidden="true" />
              ) : (
                <ChevronRight12Regular aria-hidden="true" />
              )}
            </button>
          ) : (
            <span className="ul-toggle" aria-hidden="true" />
          )}
          <i className="dot" style={{ background: color }} />
          <span className={n.parentId === null ? 'ul-name is-root' : 'ul-name'}>
            {name}
          </span>
          <span className="ul-model mono small muted">
            {shortModelName(n.modelLabel)}
          </span>
          {n.effort ? (
            <span className="ul-effort small">{n.effort}</span>
          ) : (
            <span />
          )}
          <div className="up-bar ul-bar">
            <span style={{ width: `${s * 100}%`, background: color }} />
          </div>
          <span className="mono muted up-share">{share(s)}</span>
          <b className="mono ul-eur">{cost(n)}</b>
        </div>
        {open && n.children.length > 0 && (
          <ul role="group">{n.children.map((c) => render(c, level + 1))}</ul>
        )}
      </li>
    );
  };
  if (nodes.length === 0)
    return <div className="small muted">No billable usage yet</div>;
  return (
    <ul role="tree" aria-label="Cost per agent" className="ul-tree">
      {nodes.map((n) => render(n, 1))}
    </ul>
  );
}
