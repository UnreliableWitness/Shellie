import { describe, expect, it } from 'vitest';
import type { BrainPageRow } from '../../../shared/brain';
import {
  fitLayout,
  layoutTick,
  neighbours,
  pageGraph,
  seedLayout,
  settleLayout,
} from './pageGraph';

const row = (path: string, linkedFrom: string[] = []): BrainPageRow => ({
  path,
  title: path,
  summary: '',
  type: 'other',
  lastUpdated: null,
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom,
});

describe('pageGraph', () => {
  it('links pages once per pair, whichever way they point, and skips self links and unknown pages', () => {
    const g = pageGraph([
      row('a', ['b', 'a', 'sources/x.md']),
      row('b', ['a']),
      row('c', ['a']),
    ]);
    expect(g.nodes.map((n) => n.path)).toEqual(['a', 'b', 'c']);
    expect(g.links).toHaveLength(2);
    expect(g.nodes.map((n) => n.degree)).toEqual([2, 1, 1]);
    expect(g.total).toBe(3);
  });

  it('keeps the most linked pages over the limit, counting links on the whole brain', () => {
    const rows = [
      row('hub', ['x', 'y', 'z']),
      row('x'),
      row('y'),
      row('z', ['y']),
      row('lonely'),
    ];
    const g = pageGraph(rows, 3);
    expect(g.nodes.map((n) => n.path)).toEqual(['hub', 'y', 'z']);
    expect(g.total).toBe(5);
    expect(g.links).toHaveLength(3);
    expect(g.nodes.map((n) => n.degree)).toEqual([2, 2, 2]);
  });
});

describe('layout', () => {
  const graph = () =>
    pageGraph([
      row('a', ['b', 'c', 'd']),
      row('b', ['c']),
      row('c'),
      row('d'),
      row('e'),
    ]);

  it('starts the same way every time', () => {
    const g1 = graph();
    const g2 = graph();
    seedLayout(g1, 600, 300);
    seedLayout(g2, 600, 300);
    expect(g1.nodes.map((n) => [n.x, n.y])).toEqual(
      g2.nodes.map((n) => [n.x, n.y]),
    );
  });

  it('pushes dots that start on top of each other apart and keeps them inside', () => {
    const g = graph();
    for (const n of g.nodes) {
      n.x = 300;
      n.y = 150;
    }
    settleLayout(g, 600, 300);
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(24);
      expect(n.x).toBeLessThanOrEqual(576);
      expect(n.y).toBeGreaterThanOrEqual(24);
      expect(n.y).toBeLessThanOrEqual(276);
    }
    const [a, b] = g.nodes;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(20);
  });

  it('moves nothing at alpha 0', () => {
    const g = graph();
    seedLayout(g, 600, 300);
    const before = g.nodes.map((n) => [n.x, n.y]);
    layoutTick(g, 600, 300, 0);
    expect(g.nodes.map((n) => [n.x, n.y])).toEqual(before);
  });

  it('stretches a settled layout to fill a wide area, at most 1.6 times per axis', () => {
    const g = graph();
    g.nodes.forEach((n, i) => {
      n.x = 280 + i * 10;
      n.y = 140 + (i % 2) * 20;
    });
    fitLayout(g, 600, 300);
    const xs = g.nodes.map((n) => n.x);
    const ys = g.nodes.map((n) => n.y);
    expect(Math.min(...xs)).toBeCloseTo(268);
    expect(Math.max(...xs)).toBeCloseTo(332);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(32);
    for (const n of g.nodes) {
      n.x = 100 + n.x;
    }
    fitLayout(g, 600, 300, 100);
    expect(Math.min(...g.nodes.map((n) => n.x))).toBeCloseTo(24);
    expect(Math.max(...g.nodes.map((n) => n.x))).toBeCloseTo(576);
  });

  it('finds a page and its neighbours', () => {
    const g = graph();
    expect([...neighbours(g, 2)].sort()).toEqual([0, 1, 2]);
  });
});
