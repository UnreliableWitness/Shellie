import type { Connection, Repo, Task } from './types';
import { taskWorkspaces } from './workspaces';

/** A finished task adds to the graph for this long after it finished. */
export const EDGE_WINDOW_DAYS = 90;

export type GraphNode = {
  repoId: string;
  name: string;
  baseBranch: string;
  openTasks: number;
  prOpen: boolean;
  setupMissing: boolean;
  projectName: string | null;
  foundByClaude: boolean;
};
/** Two repos that share tasks; `a < b` by repoId. */
export type GraphEdge = { a: string; b: string; taskIds: string[] };
export type ProjectGraph = {
  linked: GraphNode[];
  elsewhere: GraphNode[];
  edges: GraphEdge[];
};

/**
 * The tasks of a project, finished ones of any age: those whose home repo is linked to it now (a task without a
 * repo follows its own connection).
 */
export function tasksOfProject(
  tasks: Task[],
  repos: Repo[],
  connectionId: string,
): Task[] {
  return tasks.filter((t) => {
    const home =
      t.repoId === null
        ? t.connectionId
        : (repos.find((r) => r.id === t.repoId)?.connectionId ?? null);
    return home === connectionId;
  });
}

/** The tasks of a project ({@link tasksOfProject}), unless finished longer ago than the edge window. */
export function projectTasks(
  tasks: Task[],
  repos: Repo[],
  connectionId: string,
  now: Date,
): Task[] {
  const cutoff = now.getTime() - EDGE_WINDOW_DAYS * 86_400_000;
  return tasksOfProject(tasks, repos, connectionId).filter(
    (t) =>
      t.status !== 'done' ||
      (t.finishedAt !== null && Date.parse(t.finishedAt) >= cutoff),
  );
}

/** The repo ids a task works in, without the ones it dropped, each once (a task without a repo has an empty home). */
function liveRepoIds(task: Task): string[] {
  return [
    ...new Set(
      taskWorkspaces(task)
        .filter((w) => !w.dropped && w.repoId !== '')
        .map((w) => w.repoId),
    ),
  ];
}

/** The map key of the edge between two repos, `a < b`. */
export const edgeKey = (e: Pick<GraphEdge, 'a' | 'b'>): string =>
  `${e.a}\u0000${e.b}`;

export function projectGraph(input: {
  tasks: Task[];
  repos: Repo[];
  connections: Pick<Connection, 'id' | 'project'>[];
  connectionId: string;
  now: Date;
}): ProjectGraph {
  const { repos, connections, connectionId, now } = input;
  const tasks = projectTasks(input.tasks, repos, connectionId, now);
  const open = tasks.filter((t) => t.status !== 'done');

  const node = (r: Repo): GraphNode => ({
    repoId: r.id,
    name: r.name,
    baseBranch: r.baseBranch,
    openTasks: 0,
    prOpen: false,
    setupMissing: !r.configFound && r.overrides.setup === undefined,
    projectName:
      connections.find((c) => c.id === r.connectionId)?.project ?? null,
    foundByClaude: false,
  });

  const linked = repos.filter((r) => r.connectionId === connectionId).map(node);
  for (const t of open) {
    const home = linked.find((l) => l.repoId === t.repoId);
    if (home) {
      home.openTasks += 1;
      if (t.pullRequest !== null) home.prOpen = true;
    }
    for (const w of t.extraWorkspaces) {
      if (w.dropped || w.pullRequest === null) continue;
      const n = linked.find((l) => l.repoId === w.repoId);
      if (n) n.prOpen = true;
    }
  }

  const elsewhere: GraphNode[] = [];
  const allDetected = new Map<string, boolean>();
  for (const t of tasks) {
    for (const w of t.extraWorkspaces) {
      if (w.dropped) continue;
      const repo = repos.find((r) => r.id === w.repoId);
      if (!repo || repo.connectionId === connectionId) continue;
      if (!allDetected.has(repo.id)) elsewhere.push(node(repo));
      allDetected.set(
        repo.id,
        (allDetected.get(repo.id) ?? true) && w.source === 'detected',
      );
    }
  }
  for (const n of elsewhere)
    n.foundByClaude = allDetected.get(n.repoId) === true;

  const edges = new Map<string, GraphEdge>();
  for (const t of tasks) {
    const ids = liveRepoIds(t).sort();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const key = edgeKey({ a: ids[i], b: ids[j] });
        const e = edges.get(key) ?? { a: ids[i], b: ids[j], taskIds: [] };
        e.taskIds.push(t.id);
        edges.set(key, e);
      }
  }

  return { linked, elsewhere, edges: [...edges.values()] };
}
