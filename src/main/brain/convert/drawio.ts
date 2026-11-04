import zlib from 'node:zlib';
import type { Converted } from './types';

type Cell = {
  id: string;
  parent: string;
  label: string;
  vertex: boolean;
  edge: boolean;
  source: string;
  target: string;
};

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X'
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? whole;
  });
}

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g))
    out[m[1]] = decodeEntities(m[2]);
  return out;
}

/** A label as plain text: draw.io labels may hold HTML (`<br>`, `<div>`, entities). */
function textOf(label: string): string {
  return decodeEntities(
    label
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(div|p|li)>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** The `<mxGraphModel>` of a page, inflating the compressed form (base64 of raw deflate of URL-encoded XML). */
function modelOf(content: string): string {
  if (content.includes('<mxGraphModel')) return content;
  const raw = zlib
    .inflateRawSync(Buffer.from(content.trim(), 'base64'))
    .toString('latin1');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function cellsOf(model: string): Cell[] {
  const cells: Cell[] = [];
  // <UserObject>/<object> carry the id and label of the <mxCell> inside them.
  let wrapper: Record<string, string> | null = null;
  for (const m of model.matchAll(
    /<(mxCell|UserObject|object)\b([^>]*?)\/?>/g,
  )) {
    const a = attrsOf(m[2]);
    if (m[1] !== 'mxCell') {
      wrapper = a;
      continue;
    }
    const w = wrapper ?? {};
    wrapper = null;
    cells.push({
      id: a.id ?? w.id ?? '',
      parent: a.parent ?? '',
      label: textOf(a.value ?? w.label ?? ''),
      vertex: a.vertex === '1',
      edge: a.edge === '1',
      source: a.source ?? '',
      target: a.target ?? '',
    });
  }
  return cells;
}

/** Mermaid text in quotes: quotes and pipes as entity codes. */
const quoted = (s: string) =>
  `"${(s || ' ').replace(/"/g, '#quot;').replace(/\|/g, '#124;')}"`;

function mermaidOf(cells: Cell[]): string[] {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const edges = cells.filter((c) => c.edge);
  const edgeIds = new Set(edges.map((e) => e.id));
  // Labels drawn on an edge are vertices whose parent is that edge.
  const edgeLabel = new Map<string, string[]>();
  for (const c of cells) {
    if (c.vertex && edgeIds.has(c.parent) && c.label) {
      edgeLabel.set(c.parent, [...(edgeLabel.get(c.parent) ?? []), c.label]);
    }
  }
  const linked = new Set(
    edges
      .filter((e) => byId.get(e.source)?.vertex && byId.get(e.target)?.vertex)
      .flatMap((e) => [e.source, e.target]),
  );
  const vertices = cells.filter((c) => c.vertex && !edgeIds.has(c.parent));
  const children = new Map<string, Cell[]>();
  for (const v of vertices)
    children.set(v.parent, [...(children.get(v.parent) ?? []), v]);

  const ids = new Map<string, string>();
  const nodeId = (id: string) => {
    if (!ids.has(id)) ids.set(id, `n${ids.size + 1}`);
    return ids.get(id)!;
  };
  const kept = (v: Cell): boolean =>
    Boolean(v.label) ||
    linked.has(v.id) ||
    (children.get(v.id) ?? []).some(kept);

  const lines: string[] = [];
  const emit = (v: Cell, depth: number) => {
    if (!kept(v)) return;
    const pad = '  '.repeat(depth);
    const inner = children.get(v.id);
    if (inner?.length) {
      lines.push(`${pad}subgraph ${nodeId(v.id)}[${quoted(v.label)}]`);
      for (const c of inner) emit(c, depth + 1);
      lines.push(`${pad}end`);
    } else {
      lines.push(`${pad}${nodeId(v.id)}[${quoted(v.label)}]`);
    }
  };
  const isTop = (v: Cell) => !byId.get(v.parent)?.vertex;
  for (const v of vertices) if (isTop(v)) emit(v, 1);
  for (const e of edges) {
    if (!linked.has(e.source) || !linked.has(e.target)) continue;
    const label = [e.label, ...(edgeLabel.get(e.id) ?? [])]
      .filter(Boolean)
      .join(' ');
    const arrow = label ? `-->|${quoted(label)}|` : '-->';
    lines.push(`  ${nodeId(e.source)} ${arrow} ${nodeId(e.target)}`);
  }
  return lines.length ? ['```mermaid', 'flowchart TD', ...lines, '```'] : [];
}

/** Converts a draw.io file to markdown: per page a Mermaid flowchart of the shapes and connections, then every label as a list. */
export function drawioToMarkdown(xml: string): Converted {
  const pages = [
    ...xml.matchAll(/<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g),
  ].map((m, i) => ({
    name: attrsOf(m[1]).name || `Page ${i + 1}`,
    content: m[2],
  }));
  if (pages.length === 0 && xml.includes('<mxGraphModel'))
    pages.push({ name: 'Page 1', content: xml });

  const out: string[] = [];
  const warnings: string[] = [];
  for (const page of pages) {
    let cells: Cell[];
    try {
      cells = cellsOf(modelOf(page.content));
    } catch {
      warnings.push(`page "${page.name}" could not be read`);
      continue;
    }
    const labels = cells.map((c) => c.label).filter(Boolean);
    const chart = mermaidOf(cells);
    if (chart.length === 0 && labels.length === 0) continue;
    out.push(`## ${page.name}`, '', ...chart);
    if (labels.length) out.push('', ...labels.map((l) => `- ${l}`));
    out.push('');
  }
  if (out.length === 0) {
    warnings.push('no readable shapes or text');
    return {
      markdown: '_This diagram has no readable shapes or text._\n',
      title: null,
      images: [],
      warnings,
      empty: false,
    };
  }
  return {
    markdown: out.join('\n'),
    title: null,
    images: [],
    warnings,
    empty: false,
  };
}
