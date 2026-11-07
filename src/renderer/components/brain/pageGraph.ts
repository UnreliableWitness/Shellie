import type { BrainPageRow, BrainPageType } from '../../../shared/brain';

/** At most this many pages are drawn; a bigger brain shows its most linked pages. */
export const GRAPH_MAX_NODES = 150;

/** One page as a dot, with where it is and where it is heading. */
export type GraphNode = {
  path: string;
  title: string;
  type: BrainPageType;
  /** Links to and from other drawn pages. */
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

/** The pages and the links between them, links as node indexes, each pair once. */
export type PageGraph = {
  nodes: GraphNode[];
  links: [number, number][];
  /** All pages, drawn or not. */
  total: number;
};

/**
 * The wiki's pages and the links between them, from each row's `linkedFrom`. A link counts once whichever way it
 * points, and only between two pages (sources and broken targets stay out). Over `max` pages, the most linked ones
 * are kept (ties by title), counted on the whole brain.
 */
export function pageGraph(
  rows: BrainPageRow[],
  max = GRAPH_MAX_NODES,
): PageGraph {
  const known = new Set(rows.map((r) => r.path));
  const pairs = new Map<string, [string, string]>();
  for (const r of rows)
    for (const from of r.linkedFrom) {
      if (from === r.path || !known.has(from)) continue;
      const [a, b] = from < r.path ? [from, r.path] : [r.path, from];
      pairs.set(`${a}\n${b}`, [a, b]);
    }
  const degree = new Map<string, number>();
  for (const [a, b] of pairs.values()) {
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  const kept =
    rows.length <= max
      ? rows
      : [...rows]
          .sort(
            (a, b) =>
              (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0) ||
              a.title.localeCompare(b.title),
          )
          .slice(0, max);
  const index = new Map(kept.map((r, i) => [r.path, i]));
  const links: [number, number][] = [];
  for (const [a, b] of pairs.values()) {
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia !== undefined && ib !== undefined) links.push([ia, ib]);
  }
  const nodes: GraphNode[] = kept.map((r) => ({
    path: r.path,
    title: r.title,
    type: r.type,
    degree: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
  }));
  for (const [a, b] of links) {
    nodes[a].degree++;
    nodes[b].degree++;
  }
  return { nodes, links, total: rows.length };
}

/** A dot's radius: bigger the more links it has, capped so a hub does not cover its neighbours. */
export function nodeRadius(node: GraphNode): number {
  return 4 + Math.min(node.degree, 10) * 1.2;
}

/** Margin kept free around the drawing, so dots and their labels stay inside. */
const MARGIN = 24;

/**
 * Puts the dots on a sunflower spiral around the middle, `spread` of the way out (0.3 for a start that drifts
 * outwards, 1 for the whole area). The same graph always starts the same way.
 */
export function seedLayout(
  graph: PageGraph,
  width: number,
  height: number,
  spread = 1,
): void {
  const n = graph.nodes.length;
  const rx = ((width / 2 - MARGIN) * spread) / Math.sqrt(Math.max(n, 1));
  const ry = ((height / 2 - MARGIN) * spread) / Math.sqrt(Math.max(n, 1));
  graph.nodes.forEach((node, i) => {
    const r = Math.sqrt(i + 0.5);
    const a = i * 2.399963; // the golden angle
    node.x = width / 2 + Math.cos(a) * r * rx;
    node.y = height / 2 + Math.sin(a) * r * ry;
    node.vx = 0;
    node.vy = 0;
  });
}

/**
 * One step of the layout: dots push each other apart, links pull their ends to a set length, and a weak pull to the
 * middle (weaker sideways, for a wide area) keeps the graph together. `alpha` (0..1) scales the step, so the layout
 * settles as it falls. The link length follows the room each dot has.
 */
export function layoutTick(
  graph: PageGraph,
  width: number,
  height: number,
  alpha: number,
): void {
  const { nodes, links } = graph;
  const n = nodes.length;
  if (!n) return;
  const room = Math.sqrt((width * height) / n);
  const length = Math.min(120, Math.max(36, room * 0.75));
  const push = length * length * 0.58;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const a = nodes[i];
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      if (dx === 0 && dy === 0) {
        dx = (i - j) * 0.01;
        dy = 0.01;
      }
      const d2 = dx * dx + dy * dy;
      const d = Math.sqrt(d2);
      const f = (push / d2) * alpha;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
  for (const [ia, ib] of links) {
    const a = nodes[ia];
    const b = nodes[ib];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - length) * 0.02 * alpha;
    a.vx += (dx / d) * f;
    a.vy += (dy / d) * f;
    b.vx -= (dx / d) * f;
    b.vy -= (dy / d) * f;
  }
  for (const node of nodes) {
    node.vx += (width / 2 - node.x) * 0.0007 * alpha;
    node.vy += (height / 2 - node.y) * 0.006 * alpha;
    node.x = clamp(node.x + node.vx * 0.5, MARGIN, width - MARGIN);
    node.y = clamp(node.y + node.vy * 0.5, MARGIN, height - MARGIN);
    node.vx *= 0.6;
    node.vy *= 0.6;
  }
}

/** Runs the layout to rest at once (reduced motion, or a first frame without animation). */
export function settleLayout(
  graph: PageGraph,
  width: number,
  height: number,
  steps = 300,
): void {
  for (let i = 0; i < steps; i++) layoutTick(graph, width, height, 1);
}

/**
 * Stretches a settled layout to fill the area: the layout keeps its own spacing, which on a wide area leaves the sides
 * empty. Each axis stretches at most `maxStretch` times, so a small graph is not blown up.
 */
export function fitLayout(
  graph: PageGraph,
  width: number,
  height: number,
  maxStretch = 1.6,
): void {
  const { nodes } = graph;
  if (nodes.length < 2) return;
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const fit = (vs: number[], size: number) => {
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const k = Math.min(maxStretch, (size - 2 * MARGIN) / Math.max(hi - lo, 1));
    return (v: number) => size / 2 + (v - (lo + hi) / 2) * k;
  };
  const fx = fit(xs, width);
  const fy = fit(ys, height);
  for (const n of nodes) {
    n.x = clamp(fx(n.x), MARGIN, width - MARGIN);
    n.y = clamp(fy(n.y), MARGIN, height - MARGIN);
  }
}

/** The drawn pages linked to `index`, and `index` itself. */
export function neighbours(graph: PageGraph, index: number): Set<number> {
  const out = new Set([index]);
  for (const [a, b] of graph.links) {
    if (a === index) out.add(b);
    if (b === index) out.add(a);
  }
  return out;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
