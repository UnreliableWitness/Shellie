import { describe, expect, it } from 'vitest';
import type { GraphNode, ProjectGraph } from '../../../shared/projectGraph';
import { layoutGraph } from './layout';

const node = (repoId: string): GraphNode => ({
  repoId,
  name: repoId,
  baseBranch: 'main',
  openTasks: 0,
  prOpen: false,
  setupMissing: false,
  projectName: null,
  foundByClaude: false,
});

const graph = (over: Partial<ProjectGraph> = {}): ProjectGraph => ({
  linked: [node('a'), node('b')],
  elsewhere: [],
  edges: [],
  ...over,
});

describe('layoutGraph', () => {
  it('two columns when elsewhere is non-empty, one centred column otherwise', () => {
    const two = layoutGraph(graph({ elsewhere: [node('x')] }), 800);
    expect(two.nodes.map((n) => [n.node.repoId, n.column, n.x])).toEqual([
      ['a', 'linked', 20],
      ['b', 'linked', 20],
      ['x', 'elsewhere', 800 - 20 - 220],
    ]);
    expect(two.nodes.map((n) => n.colour)).toEqual([1, 2, 1]);

    const one = layoutGraph(graph(), 800);
    expect(one.nodes.map((n) => n.x)).toEqual([290, 290]);
    expect(one.nodes.map((n) => [n.y, n.w, n.h])).toEqual([
      [45, 220, 50],
      [125, 220, 50],
    ]);
  });

  it('height grows with the taller column', () => {
    expect(layoutGraph(graph({ linked: [] }), 800).height).toBe(65);
    expect(layoutGraph(graph({ linked: [node('a')] }), 800).height).toBe(115);
    expect(layoutGraph(graph(), 800).height).toBe(45 + 50 + 30 + 50 + 20);
    const tallRight = graph({
      elsewhere: [node('x'), node('y'), node('z')],
    });
    expect(layoutGraph(tallRight, 800).height).toBe(45 + 3 * 50 + 2 * 30 + 20);
  });

  it('an edge between two linked repos has its label in the gutter', () => {
    const g = graph({
      elsewhere: [node('x')],
      edges: [{ a: 'a', b: 'b', taskIds: ['t1'] }],
    });
    const { edges } = layoutGraph(g, 800);
    expect(edges).toHaveLength(1);
    const { label, path } = edges[0];
    expect(label.x).toBeGreaterThan(20 + 220);
    expect(label.x).toBeLessThan(800 - 20 - 220);
    expect(label.y).toBeCloseTo((45 + 25 + 125 + 25) / 2);
    expect(path).toMatch(/^M 240 70 C /);
  });

  it('a cross-column edge joins the facing edges, and an edge to an unknown repo is dropped', () => {
    const g = graph({
      elsewhere: [node('x')],
      edges: [
        { a: 'b', b: 'x', taskIds: ['t1', 't2'] },
        { a: 'a', b: 'gone', taskIds: ['t3'] },
      ],
    });
    const { edges } = layoutGraph(g, 800);
    expect(edges).toHaveLength(1);
    expect(edges[0].path).toMatch(/^M 240 150 C .* 560 70$/);
    expect(edges[0].label).toEqual({ x: 400, y: 110 });
  });
});
