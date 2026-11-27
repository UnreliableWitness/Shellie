import {
  BRAIN_PAGE_TYPES,
  type BrainBook,
  type BrainPageRow,
  type BrainPageType,
} from '../../../../shared/brain';
import { TYPE_LABELS } from '../brainTree';

/** At most this many pages are drawn; a bigger brain shows its most linked pages. */
export const SKY_MAX_STARS = 2000;

/** A star's colour by page type on the dark page: light, drawn as light added to the background. */
export const SKY_TYPE_COLOR: Record<BrainPageType, string> = {
  subject: '#5fe0c2',
  account: '#f2f5ff',
  scope: '#b79bff',
  component: '#6fb1ff',
  glossary: '#9fb0c8',
  decision: '#ffc45c',
  meeting: '#ff86b8',
  lesson: '#ff9a6b',
  digest: '#9fb0c8',
  other: '#9fb0c8',
};

/** The same types on the light page: deep colours, drawn as ink over the background. */
export const SKY_TYPE_COLOR_LIGHT: Record<BrainPageType, string> = {
  subject: '#0b8f76',
  account: '#3b4252',
  scope: '#6a45d6',
  component: '#0b6fd1',
  glossary: '#5c6b82',
  decision: '#b87400',
  meeting: '#c8286f',
  lesson: '#cf5a1e',
  digest: '#5c6b82',
  other: '#5c6b82',
};

/** One page as a star. */
export type Star = {
  path: string;
  title: string;
  type: BrainPageType;
  /** Index into `Sky.clusters`. */
  cluster: number;
  x: number;
  y: number;
  z: number;
  /** Bigger the more pages link to or from it. */
  size: number;
  /** Brighter the more recently updated, a little more when a person verified it. */
  bright: number;
  /** Days since `last_updated`; `UNDATED_DAYS` without one. */
  ageDays: number;
  isNew: boolean;
  /** The stars it is linked with, either way, each once. */
  links: number[];
};

/** A chapter (or, without a book, a page type) as a place in space. */
export type Cluster = {
  title: string;
  /** The chapter's number from 1; 0 for a cluster that has none. */
  number: number;
  x: number;
  y: number;
  z: number;
  r: number;
};

export type Sky = {
  stars: Star[];
  /** Each linked pair once, as star indexes. */
  links: [number, number][];
  clusters: Cluster[];
  /** All pages, drawn or not. */
  total: number;
};

const DAY = 864e5;
/** A page without a date counts as this old. */
const UNDATED_DAYS = 200;
const GOLDEN_ANGLE = 2.399963;
export const BACK_OF_BOOK = 'Back of the book';

/** A small seeded generator (mulberry32), so the same brain always gives the same sky. */
function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The linked pairs among `rows`, from each row's `linkedFrom`: a pair once whichever way it points. */
function linkedPairs(rows: BrainPageRow[]): [string, string][] {
  const known = new Set(rows.map((r) => r.path));
  const pairs = new Map<string, [string, string]>();
  for (const r of rows)
    for (const from of r.linkedFrom) {
      if (from === r.path || !known.has(from)) continue;
      const pair: [string, string] =
        from < r.path ? [from, r.path] : [r.path, from];
      pairs.set(pair.join('\n'), pair);
    }
  return [...pairs.values()];
}

/**
 * A brain as a sky. A cluster per chapter of the book, in the book's order along a slow helix, so a place in space
 * is a place in the book; the pages no chapter lists form "Back of the book". Without a book, a cluster per page
 * type. Inside a cluster the most linked pages sit near the middle. Over `max` pages the most linked are kept
 * (ties by title), counted on the whole brain.
 */
export function skyLayout(
  rows: BrainPageRow[],
  book: BrainBook | null,
  newPaths: ReadonlySet<string>,
  today: number,
  max = SKY_MAX_STARS,
): Sky {
  const pairs = linkedPairs(rows);
  const degreeOf = new Map<string, number>();
  for (const pair of pairs)
    for (const path of pair) degreeOf.set(path, (degreeOf.get(path) ?? 0) + 1);
  const kept =
    rows.length <= max
      ? rows
      : [...rows]
          .sort(
            (a, b) =>
              (degreeOf.get(b.path) ?? 0) - (degreeOf.get(a.path) ?? 0) ||
              a.title.localeCompare(b.title),
          )
          .slice(0, max);
  const index = new Map(kept.map((r, i) => [r.path, i]));
  const links: [number, number][] = [];
  const linked: number[][] = kept.map(() => []);
  for (const [a, b] of pairs) {
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia === undefined || ib === undefined) continue;
    links.push([ia, ib]);
    linked[ia].push(ib);
    linked[ib].push(ia);
  }

  // Which cluster each star is in, and the clusters' names.
  const clusterOf = kept.map(() => -1);
  const named: { title: string; number: number }[] = [];
  if (book) {
    book.chapters.forEach((chapter, c) => {
      named.push({ title: chapter.title, number: c + 1 });
      for (const path of chapter.pages) {
        const i = index.get(path);
        if (i !== undefined && clusterOf[i] < 0) clusterOf[i] = c;
      }
    });
    if (clusterOf.includes(-1)) {
      named.push({ title: BACK_OF_BOOK, number: 0 });
      clusterOf.forEach((c, i) => {
        if (c < 0) clusterOf[i] = named.length - 1;
      });
    }
  } else {
    for (const type of BRAIN_PAGE_TYPES) {
      if (!kept.some((r) => r.type === type)) continue;
      named.push({ title: TYPE_LABELS[type], number: 0 });
      kept.forEach((r, i) => {
        if (r.type === type) clusterOf[i] = named.length - 1;
      });
    }
  }
  if (kept.length === 0)
    return { stars: [], links: [], clusters: [], total: rows.length };

  const members: number[][] = named.map(() => []);
  clusterOf.forEach((c, i) => members[c].push(i));
  const n = named.length;
  const wide = n > 5;
  const clusters: Cluster[] = named.map((name, i) => {
    const angle = i * 0.95 - 0.6;
    const radius = wide ? 96 : 46;
    return {
      ...name,
      x: Math.cos(angle) * radius,
      y: (i - (n - 1) / 2) * (wide ? 11 : 8),
      z: Math.sin(angle) * radius,
      r: 7 + Math.sqrt(members[i].length) * 4.2,
    };
  });

  const maxDegree = Math.max(1, ...linked.map((l) => l.length));
  const random = seeded(kept.length * 31 + 5);
  const stars: Star[] = kept.map((r, i) => {
    const time = r.lastUpdated ? Date.parse(r.lastUpdated) : NaN;
    const ageDays = Number.isNaN(time)
      ? UNDATED_DAYS
      : Math.max(0, Math.round((today - time) / DAY));
    return {
      path: r.path,
      title: r.title,
      type: r.type,
      cluster: clusterOf[i],
      x: 0,
      y: 0,
      z: 0,
      size: 6.5 + 9 * Math.sqrt(linked[i].length / maxDegree),
      bright: 0.32 + 0.68 * Math.exp(-ageDays / 70) + (r.verified ? 0.12 : 0),
      ageDays,
      isNew: newPaths.has(r.path),
      links: linked[i],
    };
  });
  members.forEach((ids, c) => {
    const cluster = clusters[c];
    ids.forEach((id, k) => {
      const star = stars[id];
      // A Fibonacci sphere: evenly spread, and no two stars in one place.
      const up = 1 - (2 * (k + 0.5)) / ids.length;
      const ring = Math.sqrt(1 - up * up);
      const turn = k * GOLDEN_ANGLE + c;
      const out =
        cluster.r *
        (0.25 + 0.75 * (1 - 0.7 * (star.links.length / maxDegree))) *
        (0.75 + 0.25 * random());
      star.x = cluster.x + Math.cos(turn) * ring * out;
      star.y = cluster.y + up * out * 0.8;
      star.z = cluster.z + Math.sin(turn) * ring * out;
    });
  });
  return { stars, links, clusters, total: rows.length };
}

/** The brain at a glance, for the panel when no page is open. */
export function skyFacts(sky: Sky): {
  pages: number;
  links: number;
  changed14: number;
  untouched120: number;
} {
  return {
    pages: sky.total,
    links: sky.links.length,
    changed14: sky.stars.filter((s) => s.ageDays <= 14).length,
    untouched120: sky.stars.filter((s) => s.ageDays > 120).length,
  };
}

/**
 * The stars whose page matches `query` in its title, summary or type (any case), best first: a title that starts
 * with the query, then the most linked.
 */
export function skyMatches(
  rows: BrainPageRow[],
  sky: Sky,
  query: string,
): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const starts = (i: number) =>
    sky.stars[i].title.toLowerCase().startsWith(q) ? 1 : 0;
  return sky.stars
    .map((s, i) => i)
    .filter((i) => {
      const s = sky.stars[i];
      const summary = byPath.get(s.path)?.summary ?? '';
      return `${s.title}\n${summary}\n${s.type}`.toLowerCase().includes(q);
    })
    .sort(
      (a, b) =>
        starts(b) - starts(a) ||
        sky.stars[b].links.length - sky.stars[a].links.length ||
        sky.stars[a].title.localeCompare(sky.stars[b].title),
    );
}
