import {
  type KeyboardEvent,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  GraphEdge,
  GraphNode,
  ProjectGraph,
} from '../../../shared/projectGraph';
import { edgeKey } from '../../../shared/projectGraph';
import { clip, plural } from '../../../shared/text';
import { layoutGraph, type Placed } from './layout';

/** The width laid out until the band is measured (and in tests, where nothing has a size). */
const DEFAULT_WIDTH = 760;
const MAX_NAME = 28;
/** The width of an edge's invisible hit line, so a 1px line is easy to click. */
const HIT_WIDTH = 12;

function monoLine(p: Placed): string {
  const n = p.node;
  if (p.column === 'elsewhere')
    return `${n.projectName ? `project ${n.projectName}` : 'no project'}${n.foundByClaude ? ' · found by Claude' : ''}`;
  return `${n.baseBranch} · ${n.openTasks > 0 ? plural(n.openTasks, 'open task') : 'no open tasks'}${n.prOpen ? ' · PR open' : ''}`;
}

/** Enter and Space act like a click on an SVG element that plays a button or link. */
const onKeys =
  (run: (e: SyntheticEvent) => void) => (e: KeyboardEvent<SVGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      run(e);
    }
  };

/** The repositories of a project as two columns of nodes joined by lines for the tasks they share. */
export function RepoGraph({
  graph,
  onNode,
  onEdge,
  onStart,
}: {
  graph: ProjectGraph;
  onNode(repoId: string): void;
  onEdge(edge: GraphEdge, anchor: SVGElement): void;
  onStart(repoId: string): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [hover, setHover] = useState<
    { node: string } | { edge: GraphEdge } | null
  >(null);

  const { nodes, edges, height } = layoutGraph(graph, width);
  const names = new Map(nodes.map((p) => [p.node.repoId, p.node.name]));
  const touches = (e: GraphEdge, id: string) => e.a === id || e.b === id;
  const hotEdge = (e: GraphEdge) =>
    hover !== null &&
    ('node' in hover
      ? touches(e, hover.node)
      : edgeKey(hover.edge) === edgeKey(e));
  const hotNode = (n: GraphNode) =>
    hover !== null &&
    ('node' in hover
      ? hover.node === n.repoId ||
        edges.some(
          (p) => touches(p.edge, hover.node) && touches(p.edge, n.repoId),
        )
      : touches(hover.edge, n.repoId));
  const clear = () => setHover(null);

  return (
    <div ref={box} className="repo-graph">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        data-hover={
          hover === null
            ? undefined
            : 'node' in hover
              ? hover.node
              : `${hover.edge.a} ${hover.edge.b}`
        }
      >
        {edges.map((p) => {
          const n = p.edge.taskIds.length;
          const label = `${plural(n, 'task')} in ${names.get(p.edge.a)} and ${names.get(p.edge.b)}`;
          const click = (e: SyntheticEvent) =>
            onEdge(p.edge, e.currentTarget as SVGElement);
          return (
            <g key={edgeKey(p.edge)} className="graph-edge-group">
              {/* A wide invisible line takes the clicks; the thin drawn line next to it is only for show. */}
              <path
                role="button"
                tabIndex={0}
                aria-label={label}
                className={
                  hotEdge(p.edge) ? 'graph-edge-hit is-hot' : 'graph-edge-hit'
                }
                d={p.path}
                stroke="transparent"
                strokeWidth={HIT_WIDTH}
                fill="none"
                onClick={click}
                onKeyDown={onKeys(click)}
                onMouseEnter={() => setHover({ edge: p.edge })}
                onMouseLeave={clear}
                onFocus={() => setHover({ edge: p.edge })}
                onBlur={clear}
              />
              <path
                aria-hidden="true"
                className="graph-edge"
                d={p.path}
                strokeWidth={n > 1 ? 2 : 1}
              />
              <circle
                className="graph-edge-count"
                cx={p.label.x}
                cy={p.label.y}
                r={8}
                aria-hidden="true"
              />
              <text
                className="graph-edge-count-text"
                x={p.label.x}
                y={p.label.y}
                aria-hidden="true"
              >
                {n}
              </text>
            </g>
          );
        })}
        {nodes.map((p) => {
          const n = p.node;
          const start =
            p.column === 'linked' && n.openTasks === 0 && !n.setupMissing;
          const click = () => onNode(n.repoId);
          const startTask = () => onStart(n.repoId);
          return (
            <g key={n.repoId}>
              <g
                role="button"
                tabIndex={0}
                aria-label={`Repository ${n.name}`}
                className={[
                  'graph-node',
                  `is-${p.column}`,
                  hotNode(n) ? 'is-hot' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={click}
                onKeyDown={onKeys(click)}
                onMouseEnter={() => setHover({ node: n.repoId })}
                onMouseLeave={clear}
                onFocus={() => setHover({ node: n.repoId })}
                onBlur={clear}
              >
                <title>{n.name}</title>
                <rect
                  className="graph-node-box"
                  x={p.x}
                  y={p.y}
                  width={p.w}
                  height={p.h}
                  rx={4}
                />
                {p.column === 'linked' && (
                  <rect
                    className="graph-node-bar"
                    x={p.x}
                    y={p.y}
                    width={4}
                    height={p.h}
                    rx={2}
                    style={{ fill: `var(--repo-${p.colour})` }}
                  />
                )}
                <text className="graph-node-name" x={p.x + 14} y={p.y + 20}>
                  {clip(n.name, MAX_NAME)}
                </text>
                <text className="graph-node-mono" x={p.x + 14} y={p.y + 38}>
                  {monoLine(p)}
                </text>
              </g>
              {p.column === 'linked' && n.setupMissing && (
                <text
                  className="graph-node-warn"
                  x={p.x + 14}
                  y={p.y + p.h + 16}
                >
                  ⚠ setup missing
                </text>
              )}
              {start && (
                <text
                  role="link"
                  tabIndex={0}
                  className="graph-node-start"
                  x={p.x + 14}
                  y={p.y + p.h + 16}
                  onClick={startTask}
                  onKeyDown={onKeys(startTask)}
                >
                  Start a task
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
