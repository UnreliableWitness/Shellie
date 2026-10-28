import type {
  ModelTotals,
  RecentPoint,
  SessionSummary,
  TaskUsage,
  UsageNode,
  UsageRecord,
  UsageTool,
} from './usage';

export type Bin = {
  start: number;
  end: number;
  costEur: number;
  byTool: Record<UsageTool, number>;
  dominant: UsageTool | null;
};

export function tokenMix(u: TaskUsage) {
  const mix = { cacheRead: 0, input: 0, cacheWrite: 0, output: 0 };
  for (const s of u.sessions.filter((x) => x.billable)) {
    mix.cacheRead += s.cacheReadTokens;
    mix.input += s.inputTokens;
    mix.cacheWrite += s.cacheWriteTokens;
    mix.output += s.outputTokens;
  }
  return mix;
}

export function timeline(
  recent: RecentPoint[],
  now: number,
  o = { hours: 6, binMinutes: 15 },
): Bin[] {
  const binMs = o.binMinutes * 60_000;
  const count = (o.hours * 60) / o.binMinutes;
  // Bins sit on clock quarter hours (every time zone is a whole number of quarter hours off UTC), so whole
  // hours fall on bin edges; the last bin is the current, partly elapsed one.
  const from = Math.floor(now / binMs) * binMs - (count - 1) * binMs;
  const bins: Bin[] = Array.from({ length: count }, (_, i) => ({
    start: from + i * binMs,
    end: from + (i + 1) * binMs,
    costEur: 0,
    byTool: { 'claude-code': 0, 'copilot-cli': 0, opencode: 0 },
    dominant: null,
  }));
  for (const p of recent) {
    const t = Date.parse(p.at);
    if (!(t >= from && t <= now)) continue;
    const i = Math.min(count - 1, Math.floor((t - from) / binMs));
    bins[i].costEur += p.costEur;
    bins[i].byTool[p.tool] += p.costEur;
  }
  const tools = Object.keys(bins[0]?.byTool ?? {}) as UsageTool[];
  for (const b of bins) {
    if (b.costEur > 0)
      b.dominant = tools.reduce((best, t) =>
        b.byTool[t] > b.byTool[best] ? t : best,
      );
  }
  return bins;
}

/** Bin edges (0 = left of the first bin, bins.length = right of the last) that fall on a local whole hour. */
export function hourTicks(bins: Bin[]): { edge: number; at: number }[] {
  const edges = [...bins.map((b) => b.start), bins.at(-1)?.end ?? 0];
  return edges.flatMap((at, edge) => {
    const d = new Date(at);
    return bins.length > 0 && d.getMinutes() === 0 && d.getSeconds() === 0
      ? [{ edge, at }]
      : [];
  });
}

const titleCase = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * A short model name for charts: "Sonnet 5.5" from the label "Claude Sonnet 5.5" or from an id like
 * `claude-sonnet-5-5` that the rate table does not know; other names stay as they are.
 */
export function shortModelName(label: string): string {
  const named = /^Claude (.+)$/.exec(label);
  if (named) return named[1];
  const id = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(label);
  if (id) return `${titleCase(id[1])} ${id[2]}${id[3] ? `.${id[3]}` : ''}`;
  return label;
}

/** The ring's legend name: the short model name, with "(Copilot)" for models used through Copilot CLI. */
export const modelLegendName = (m: ModelTotals): string =>
  m.tool === 'copilot-cli'
    ? `${shortModelName(m.label)} (Copilot)`
    : m.tool === 'opencode'
      ? `${shortModelName(m.label)} (OpenCode)`
      : shortModelName(m.label);

/** Each model's share of the priced total, 0..1. */
export const modelShares = (models: ModelTotals[]): number[] => {
  const total = models.reduce((n, m) => n + m.costEur, 0);
  return models.map((m) => (total > 0 ? m.costEur / total : 0));
};

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

type Building = {
  node: UsageNode;
  parent: string | null;
  models: Map<string, number>;
  efforts: Map<string, number>;
};

const mostUsed = (counts: Map<string, number>): string | null => {
  let best: string | null = null;
  for (const [k, n] of counts)
    if (best === null || n > counts.get(best)!) best = k;
  return best;
};

/**
 * A task's billable usage as a tree: one root per session, with its Claude Code subagents or OpenCode child
 * sessions below it. Only the grouping is new: each request counts once, so the roots add up to the billable total.
 */
export function buildUsageTree(
  records: UsageRecord[],
  o: {
    billable: (sessionId: string) => boolean;
    label: (model: string) => string;
    usdToEur: number;
  },
): UsageNode[] {
  const all = new Map<string, Building>();
  const nodeFor = (
    id: string,
    r: UsageRecord,
    label: string,
    parent: string | null,
  ): Building => {
    let b = all.get(id);
    if (!b) {
      b = {
        node: {
          id,
          label,
          tool: r.tool,
          model: r.model,
          modelLabel: '',
          effort: null,
          parentId: null,
          startedAt: r.at,
          costUsd: 0,
          costEur: 0,
          tokens: 0,
          requests: 0,
          unpricedRequests: 0,
          children: [],
        },
        parent,
        models: new Map(),
        efforts: new Map(),
      };
      all.set(id, b);
    }
    return b;
  };
  const sorted = records
    .filter((r) => o.billable(r.sessionId))
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const r of sorted) {
    const session = nodeFor(r.sessionId, r, '', null);
    if (r.parentSessionId) session.parent ??= r.parentSessionId;
    if (r.parentSessionId && r.agent) session.node.label ||= r.agent;
    const own =
      r.tool === 'claude-code' && r.agent
        ? nodeFor(`${r.sessionId}:${r.agent}`, r, r.agent, r.sessionId)
        : session;
    const n = own.node;
    n.requests++;
    n.tokens +=
      r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
    if (r.costUsd === null) n.unpricedRequests++;
    else n.costUsd = round6(n.costUsd + r.costUsd);
    own.models.set(r.model, (own.models.get(r.model) ?? 0) + 1);
    if (r.effort)
      own.efforts.set(r.effort, (own.efforts.get(r.effort) ?? 0) + 1);
  }
  // A parent that is not billable (or not in this task) leaves its child a root; a loop never links.
  const leadsTo = (from: string, target: string): boolean => {
    let at: string | null = from;
    for (let i = 0; at !== null && i <= all.size; i++) {
      if (at === target) return true;
      at = all.get(at)?.parent ?? null;
    }
    return false;
  };
  const roots: UsageNode[] = [];
  for (const b of all.values()) {
    b.node.model = mostUsed(b.models) ?? b.node.model;
    b.node.modelLabel = o.label(b.node.model);
    b.node.effort = mostUsed(b.efforts);
    const parent = b.parent !== null ? all.get(b.parent) : undefined;
    if (parent && !leadsTo(parent.node.id, b.node.id)) {
      b.node.parentId = parent.node.id;
      parent.node.children.push(b.node);
    } else roots.push(b.node);
  }
  const rollUp = (n: UsageNode): void => {
    for (const c of n.children) {
      rollUp(c);
      n.costUsd = round6(n.costUsd + c.costUsd);
      n.tokens += c.tokens;
      n.requests += c.requests;
      n.unpricedRequests += c.unpricedRequests;
    }
    n.costEur = round6(n.costUsd * o.usdToEur);
  };
  for (const r of roots) rollUp(r);
  return roots;
}

export const isLive = (
  s: SessionSummary,
  now: number,
  windowMs = 5 * 60_000,
): boolean => now - Date.parse(s.lastAt) <= windowMs;
