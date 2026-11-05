import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { GraphNode, ProjectGraph } from '../../../shared/projectGraph';
import { RepoGraph } from './RepoGraph';

const node = (repoId: string, over: Partial<GraphNode> = {}): GraphNode => ({
  repoId,
  name: repoId,
  baseBranch: 'main',
  openTasks: 0,
  prOpen: false,
  setupMissing: false,
  projectName: null,
  foundByClaude: false,
  ...over,
});

const graph: ProjectGraph = {
  linked: [
    node('webshop', { openTasks: 2, prOpen: true }),
    node('api', { setupMissing: true }),
    node('docs'),
  ],
  elsewhere: [
    node('design-system', { projectName: 'Platform', foundByClaude: true }),
  ],
  edges: [
    { a: 'design-system', b: 'webshop', taskIds: ['t1', 't2'] },
    { a: 'api', b: 'webshop', taskIds: ['t3'] },
  ],
};

const draw = () => {
  const on = { onNode: vi.fn(), onEdge: vi.fn(), onStart: vi.fn() };
  render(<RepoGraph graph={graph} {...on} />);
  return on;
};

describe('RepoGraph', () => {
  it('renders a button per node and per edge with the counts in the labels', () => {
    draw();
    for (const name of ['webshop', 'api', 'docs', 'design-system'])
      expect(
        screen.getByRole('button', { name: `Repository ${name}` }),
      ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: '2 tasks in design-system and webshop',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '1 task in api and webshop' }),
    ).toBeInTheDocument();
    // The button is a wide invisible hit line; the drawn line beside it is 1px, or 2px for two or more tasks.
    const wide = screen.getByRole('button', {
      name: '2 tasks in design-system and webshop',
    });
    expect(wide).toHaveAttribute('stroke-width', '12');
    expect(wide).toHaveAttribute('stroke', 'transparent');
    const drawn = wide.nextElementSibling as Element;
    expect(drawn).toHaveClass('graph-edge');
    expect(drawn).toHaveAttribute('aria-hidden', 'true');
    expect(drawn).toHaveAttribute('stroke-width', '2');
    expect(drawn.getAttribute('d')).toBe(wide.getAttribute('d'));
    expect(screen.getByText('main · 2 open tasks · PR open')).toBeVisible();
    expect(screen.getByText('⚠ setup missing')).toBeInTheDocument();
    expect(
      screen.getByText('project Platform · found by Claude'),
    ).toBeInTheDocument();
    // Only the linked repo with no open tasks and no warning offers Start a task.
    expect(screen.getAllByRole('link', { name: 'Start a task' })).toHaveLength(
      1,
    );
  });

  it('clicking a node and an edge calls back', async () => {
    const on = draw();
    await userEvent.click(
      screen.getByRole('button', { name: 'Repository webshop' }),
    );
    expect(on.onNode).toHaveBeenCalledWith('webshop');
    const edge = screen.getByRole('button', {
      name: '1 task in api and webshop',
    });
    await userEvent.click(edge);
    expect(on.onEdge).toHaveBeenCalledWith(graph.edges[1], edge);
    await userEvent.click(screen.getByRole('link', { name: 'Start a task' }));
    expect(on.onStart).toHaveBeenCalledWith('docs');
  });

  it('marks the hovered node and the edges and nodes it joins', async () => {
    const { container } = render(
      <RepoGraph
        graph={graph}
        onNode={vi.fn()}
        onEdge={vi.fn()}
        onStart={vi.fn()}
      />,
    );
    await userEvent.hover(
      screen.getByRole('button', { name: 'Repository api' }),
    );
    expect(container.querySelector('svg')).toHaveAttribute('data-hover', 'api');
    const hot = [...container.querySelectorAll('.is-hot')].map((e) =>
      e.getAttribute('aria-label'),
    );
    expect(hot).toEqual([
      '1 task in api and webshop',
      'Repository webshop',
      'Repository api',
    ]);
  });
});
