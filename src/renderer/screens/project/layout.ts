import type {
  GraphEdge,
  GraphNode,
  ProjectGraph,
} from '../../../shared/projectGraph';

export type Placed = {
  node: GraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
  column: 'linked' | 'elsewhere';
  /** 1..6, the `--repo-N` token of the node's colour bar. */
  colour: number;
};
export type PlacedEdge = {
  edge: GraphEdge;
  /** SVG path data. */
  path: string;
  label: { x: number; y: number };
};

const NODE_W = 220;
const NODE_H = 50;
const ROW_GAP = 30;
const TOP = 45;
const SIDE = 20;
const BOTTOM = 20;

/** How far a same-column edge bulges out of its column, more for nodes further apart, never past the gutter. */
const bulge = (y0: number, y1: number, room: number): number =>
  Math.min(30 + Math.abs(y1 - y0) / 4, Math.max(room - 20, 20));

/**
 * Two deterministic columns: linked repos on the left, repos used from elsewhere on the right (absent when
 * there are none: the left column centres). Edges whose repo has no node are dropped.
 */
export function layoutGraph(
  g: ProjectGraph,
  width: number,
): { nodes: Placed[]; edges: PlacedEdge[]; height: number } {
  const two = g.elsewhere.length > 0;
  const leftX = two ? SIDE : (width - NODE_W) / 2;
  const rightX = width - SIDE - NODE_W;
  const place = (
    list: GraphNode[],
    column: Placed['column'],
    x: number,
  ): Placed[] =>
    list.map((node, i) => ({
      node,
      x,
      y: TOP + i * (NODE_H + ROW_GAP),
      w: NODE_W,
      h: NODE_H,
      column,
      colour: (i % 6) + 1,
    }));
  const nodes = [
    ...place(g.linked, 'linked', leftX),
    ...place(g.elsewhere, 'elsewhere', rightX),
  ];
  const byId = new Map(nodes.map((n) => [n.node.repoId, n]));
  // The free space between the columns (or right of a lone column).
  const gutter = two ? rightX - (leftX + NODE_W) : width - (leftX + NODE_W);

  const edges: PlacedEdge[] = [];
  for (const edge of g.edges) {
    const a = byId.get(edge.a);
    const b = byId.get(edge.b);
    if (!a || !b) continue;
    const mid = (n: Placed) => n.y + n.h / 2;
    if (a.column === b.column) {
      // Same column: leave from the side facing the gutter and curve back into it.
      const linked = a.column === 'linked';
      const x0 = linked ? a.x + a.w : a.x;
      const [y0, y1] = [mid(a), mid(b)];
      const d = bulge(y0, y1, gutter) * (linked ? 1 : -1);
      edges.push({
        edge,
        path: `M ${x0} ${y0} C ${x0 + d} ${y0} ${x0 + d} ${y1} ${x0} ${y1}`,
        label: { x: x0 + 0.75 * d, y: (y0 + y1) / 2 },
      });
    } else {
      const [l, r] = a.column === 'linked' ? [a, b] : [b, a];
      const x0 = l.x + l.w;
      const x1 = r.x;
      const [y0, y1] = [mid(l), mid(r)];
      const mx = (x0 + x1) / 2;
      edges.push({
        edge,
        path: `M ${x0} ${y0} C ${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`,
        label: { x: mx, y: (y0 + y1) / 2 },
      });
    }
  }

  const rows = Math.max(g.linked.length, g.elsewhere.length);
  const column = rows === 0 ? 0 : rows * NODE_H + (rows - 1) * ROW_GAP;
  return { nodes, edges, height: column + TOP + BOTTOM };
}
