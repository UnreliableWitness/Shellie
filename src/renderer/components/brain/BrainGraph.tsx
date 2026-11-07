import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BrainPageRow } from '../../../shared/brain';
import {
  fitLayout,
  neighbours,
  nodeRadius,
  pageGraph,
  seedLayout,
  settleLayout,
} from './pageGraph';

const HEIGHT = 300;
/** Pages named without hovering: the most linked ones. */
const LABELLED = 8;
/** How long a dot takes to run along a lit link, in ms. */
const PULSE_MS = 1400;
/** How long the dots take to drift into place, in ms. */
const DRIFT_MS = 1600;

/**
 * The wiki's pages as dots and their links as lines, on the Read view's landing. The dots drift into place, then
 * float; hovering or focusing a page lights its links and names its neighbours, a click or Enter opens it. Pages in
 * `newPaths` get a ring. Positions are written straight to the SVG each frame, not through React. With reduced
 * motion the dots are drawn in place and nothing moves.
 */
export function BrainGraph({
  rows,
  newPaths,
  onOpen,
}: {
  rows: BrainPageRow[];
  newPaths: Set<string>;
  onOpen: (path: string) => void;
}) {
  const graph = useMemo(() => pageGraph(rows), [rows]);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  const nodeEls = useRef<(SVGGElement | null)[]>([]);
  const linkEls = useRef<(SVGLineElement | null)[]>([]);
  const pulseEls = useRef<(SVGCircleElement | null)[]>([]);
  /** Where each dot starts its drift, and when the drift began (null: not yet seen). */
  const from = useRef<{ x: number; y: number }[]>([]);
  const drift = useRef<number | null>(null);
  /** Where each page was last drawn, so a refetch glides pages instead of restarting them. */
  const shown = useRef(new Map<string, { x: number; y: number }>());
  const still = useMemo(reducedMotion, []);

  const lit = useMemo(
    () => (hover === null ? null : neighbours(graph, hover)),
    [graph, hover],
  );
  const litLinks = useMemo(
    () =>
      hover === null
        ? []
        : graph.links.flatMap(([a, b], i) =>
            a === hover || b === hover ? [i] : [],
          ),
    [graph, hover],
  );
  const labelled = useMemo(() => {
    const ranked = graph.nodes
      .map((n, i) => ({ i, d: n.degree }))
      .filter((n) => n.d > 0)
      .sort((a, b) => b.d - a.d)
      .slice(0, LABELLED);
    return new Set(ranked.map((n) => n.i));
  }, [graph]);
  const types = useMemo(
    () => [...new Set(graph.nodes.map((n) => n.type))],
    [graph],
  );

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Writes every dot, line and pulse where it is at time `t`: on its way from `from` to its place, then floating. */
  function place(t: number) {
    const e =
      drift.current === null ? 0 : easeOut((t - drift.current) / DRIFT_MS);
    const float = still ? 0 : 2.5 * e;
    const xs: number[] = [];
    const ys: number[] = [];
    graph.nodes.forEach((n, i) => {
      const f = from.current[i];
      xs[i] = f.x + (n.x - f.x) * e + Math.sin(t * 0.00035 + i * 1.7) * float;
      ys[i] = f.y + (n.y - f.y) * e + Math.cos(t * 0.0003 + i * 2.3) * float;
      shown.current.set(n.path, { x: xs[i], y: ys[i] });
      nodeEls.current[i]?.setAttribute(
        'transform',
        `translate(${xs[i].toFixed(1)} ${ys[i].toFixed(1)})`,
      );
    });
    graph.links.forEach(([a, b], i) => {
      const line = linkEls.current[i];
      if (!line) return;
      line.setAttribute('x1', xs[a].toFixed(1));
      line.setAttribute('y1', ys[a].toFixed(1));
      line.setAttribute('x2', xs[b].toFixed(1));
      line.setAttribute('y2', ys[b].toFixed(1));
    });
    litLinks.forEach((li, k) => {
      const dot = pulseEls.current[k];
      if (!dot) return;
      const [a, b] = graph.links[li];
      // Out from the hovered page along each of its links.
      const [src, dst] = a === hover ? [a, b] : [b, a];
      const p = ((t + k * 230) % PULSE_MS) / PULSE_MS;
      dot.setAttribute('cx', (xs[src] + (xs[dst] - xs[src]) * p).toFixed(1));
      dot.setAttribute('cy', (ys[src] + (ys[dst] - ys[src]) * p).toFixed(1));
    });
  }
  const placeRef = useRef(place);
  placeRef.current = place;

  // Each dot's place is worked out at once; the motion is only the way there. A page already on screen glides from
  // where it is, a new one from near the middle.
  useLayoutEffect(() => {
    seedLayout(graph, width, HEIGHT, 0.25);
    const middle = graph.nodes.map((n) => ({ x: n.x, y: n.y }));
    seedLayout(graph, width, HEIGHT);
    settleLayout(graph, width, HEIGHT);
    fitLayout(graph, width, HEIGHT);
    from.current = graph.nodes.map((n, i) =>
      still ? { x: n.x, y: n.y } : (shown.current.get(n.path) ?? middle[i]),
    );
    drift.current = still ? -Infinity : null;
    placeRef.current(0);
  }, [graph, width, still]);

  useEffect(() => {
    if (still) return;
    let frame = 0;
    const step = (t: number) => {
      frame = requestAnimationFrame(step);
      // Hidden (another view, or the window is away): no work, and the drift waits until it can be seen.
      if (document.hidden || !box.current?.getClientRects().length) return;
      drift.current ??= t;
      placeRef.current(t);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [graph, width, still]);

  if (graph.nodes.length < 2) return null;

  return (
    <section className="brain-graph" aria-label="How pages link">
      <div className="brain-graph-bar small">
        <strong>
          {graph.nodes.length < graph.total
            ? `${graph.nodes.length} of ${graph.total} pages`
            : `${graph.total} pages`}{' '}
          · {graph.links.length} {graph.links.length === 1 ? 'link' : 'links'}
        </strong>
        {types.map((t) => (
          <span key={t} className="muted">
            <span className="brain-graph-swatch" data-type={t} />
            {t}
          </span>
        ))}
      </div>
      <div ref={box} className="brain-graph-box">
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className={lit ? 'is-lit' : undefined}
        >
          {graph.links.map(([a, b], i) => (
            <line
              key={`${a}-${b}`}
              ref={(el) => {
                linkEls.current[i] = el;
              }}
              className={
                lit && (a === hover || b === hover)
                  ? 'brain-graph-link on'
                  : 'brain-graph-link'
              }
            />
          ))}
          {!still &&
            litLinks.map((li, k) => (
              <circle
                key={li}
                ref={(el) => {
                  pulseEls.current[k] = el;
                }}
                r={2.2}
                className="brain-graph-pulse"
              />
            ))}
          {graph.nodes.map((n, i) => {
            const r = nodeRadius(n);
            const on = !lit || lit.has(i);
            return (
              <g
                key={n.path}
                ref={(el) => {
                  nodeEls.current[i] = el;
                }}
                role="button"
                tabIndex={0}
                aria-label={n.title}
                className={[
                  'brain-graph-node',
                  on ? '' : 'dim',
                  i === hover ? 'hover' : '',
                ].join(' ')}
                data-type={n.type}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => onOpen(n.path)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  onOpen(n.path);
                }}
              >
                <title>{n.title}</title>
                {newPaths.has(n.path) && (
                  <circle r={r + 5} className="brain-graph-new" />
                )}
                <circle r={r} className="brain-graph-dot" />
                {(labelled.has(i) || (lit?.has(i) ?? false)) && (
                  <text y={r + 12} textAnchor="middle">
                    {n.title}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

/** 0..1 to 0..1, fast then slowing (cubic), held at 1 past the end. */
function easeOut(p: number) {
  const q = Math.min(1, Math.max(0, p));
  return 1 - (1 - q) ** 3;
}

function reducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
