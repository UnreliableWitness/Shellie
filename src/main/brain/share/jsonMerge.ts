/**
 * Pure merges for the brain's own files, called by the git merge when two machines changed the same file.
 * Each follows the rule table in the shared-brains spec ("Sync"); none touches the disk.
 */
import type {
  BrainBook,
  BrainChapter,
  BrainState,
} from '../../../shared/brain';
import {
  SHARED_FIELDS,
  type Members,
  type SharedFacts,
} from '../../../shared/brainShare';
import type { ConflictsFile } from '../conflicts';

/** True when `later` is strictly after `earlier`; a missing time is the earliest. */
const after = (
  later: string | null | undefined,
  earlier: string | null | undefined,
) => (later ?? '') > (earlier ?? '');

const ENTRY_START = /^(?:- |## )/;
const ENTRY_DATE = /^(?:- |## )\s*(\d{4}-\d{2}-\d{2}(?:T[\d:.]*Z?)?)/;

/** log.md as its heading part and its entries: a `- ` line or a `## ` block (with the lines under it). */
function splitLog(text: string): { head: string[]; entries: string[] } {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => ENTRY_START.test(l));
  const head = first < 0 ? lines : lines.slice(0, first);
  const entries: string[] = [];
  if (first >= 0) {
    for (const l of lines.slice(first)) {
      if (ENTRY_START.test(l)) entries.push(l);
      else if (entries.length) entries[entries.length - 1] += `\n${l}`;
    }
  }
  return {
    head,
    entries: entries.map((e) => e.replace(/\s+$/, '')).filter(Boolean),
  };
}

/**
 * Union of both sides' entries, no entry twice (exact text), newest first by the date at the start of the entry.
 * When an entry has no date, the order is ours first, then the entries only theirs has.
 */
export function mergeLog(ours: string, theirs: string): string {
  const o = splitLog(ours);
  const t = splitLog(theirs);
  // A Set keeps the first of each text, in order: ours, then the entries only theirs has.
  const all = [...new Set([...o.entries, ...t.entries])];
  const dates = all.map((e) => ENTRY_DATE.exec(e)?.[1]);
  if (dates.every(Boolean)) {
    const order = all
      .map((e, i) => ({ e, d: dates[i] as string, i }))
      .sort((a, b) => (a.d === b.d ? a.i - b.i : a.d < b.d ? 1 : -1));
    all.splice(0, all.length, ...order.map((x) => x.e));
  }
  const eol = ours.includes('\r\n') ? '\r\n' : '\n';
  let head = o.head.some((l) => l.trim()) ? o.head : t.head;
  if (!head.some((l) => l.trim())) head = ['# Log', ''];
  const body = all.map((e) => e.replace(/\n/g, eol));
  return [...head, ...body].join(eol) + eol;
}

/** captured: union, the later `at` wins; findings and lastLintAt from the later lint; lastSyncCommit the descendant, else the base's. */
export function mergeState(
  base: BrainState | null,
  ours: BrainState,
  theirs: BrainState,
  isAncestor: (a: string, b: string) => boolean,
): BrainState {
  const captured = { ...theirs.captured };
  for (const [k, v] of Object.entries(ours.captured)) {
    const t = captured[k];
    if (!t || after(v.at, t.at)) captured[k] = v;
  }
  const lint = after(ours.lastLintAt, theirs.lastLintAt) ? ours : theirs;
  const a = ours.lastSyncCommit;
  const b = theirs.lastSyncCommit;
  let lastSyncCommit: string | null;
  if (a === b) lastSyncCommit = a;
  else if (!a || !b) lastSyncCommit = a ?? b;
  else if (isAncestor(a, b)) lastSyncCommit = b;
  else if (isAncestor(b, a)) lastSyncCommit = a;
  else lastSyncCommit = base?.lastSyncCommit ?? null;
  return {
    ...theirs,
    lastSyncCommit,
    lastLintAt: lint.lastLintAt,
    findings: lint.findings,
    captured,
  };
}

type ConflictRec = ConflictsFile['conflicts'][string];

function mergeConflictRec(a: ConflictRec, b: ConflictRec): ConflictRec {
  const later = <T extends { at: string }>(x?: T, y?: T) =>
    x && y ? (after(x.at, y.at) ? x : y) : (x ?? y);
  const settled = later(a.settled, b.settled);
  const answered = later(a.answered, b.answered);
  // The furthest state wins: settled, then parked, then open (neither).
  const parked = settled ? undefined : later(a.parked, b.parked);
  return {
    ...(parked ? { parked } : {}),
    ...(answered ? { answered } : {}),
    ...(settled ? { settled } : {}),
  };
}

/** brain/conflicts.json per id: the furthest state wins (settled > parked > open), the later answer is kept. */
export function mergeConflicts(
  ours: ConflictsFile,
  theirs: ConflictsFile,
): ConflictsFile {
  const conflicts: ConflictsFile['conflicts'] = { ...theirs.conflicts };
  for (const [id, rec] of Object.entries(ours.conflicts))
    conflicts[id] = conflicts[id] ? mergeConflictRec(rec, conflicts[id]) : rec;
  return { version: 1, conflicts };
}

/** Union by key, the later `at` wins; without a later `at` on ours, theirs wins. */
export function mergeKeyedMap<T extends { at?: string }>(
  ours: Record<string, T>,
  theirs: Record<string, T>,
): Record<string, T> {
  const out: Record<string, T> = { ...theirs };
  for (const [k, v] of Object.entries(ours))
    if (!(k in out) || after(v.at, out[k].at)) out[k] = v;
  return out;
}

/** Theirs' order; chapters and pages only ours has are appended in ours' order (a page theirs placed anywhere stays there). */
export function mergeBook(ours: BrainBook, theirs: BrainBook): BrainBook {
  const placed = new Set(theirs.chapters.flatMap((c) => c.pages));
  const chapters: BrainChapter[] = theirs.chapters.map((c) => ({
    ...c,
    pages: [...c.pages],
  }));
  for (const c of ours.chapters) {
    const extra = c.pages.filter((p) => !placed.has(p));
    for (const p of extra) placed.add(p);
    const same = chapters.find((x) => x.title === c.title);
    if (same) same.pages.push(...extra);
    else chapters.push({ ...c, pages: extra });
  }
  return { chapters };
}

/** brain/shared.json: per field, the later `updatedAt` wins (theirs on a tie); the higher `templatesVersion` always wins. */
export function mergeShared(
  ours: SharedFacts,
  theirs: SharedFacts,
): SharedFacts {
  const out: SharedFacts = { ...theirs, updatedAt: { ...theirs.updatedAt } };
  const set = out as Record<string, unknown>;
  for (const f of SHARED_FIELDS) {
    // The skills version never goes back: an older Shellie's later write cannot undo a colleague's update.
    if (f === 'templatesVersion') {
      if (ours.templatesVersion > theirs.templatesVersion) {
        out.templatesVersion = ours.templatesVersion;
        out.updatedAt.templatesVersion = ours.updatedAt.templatesVersion;
      }
      continue;
    }
    if (after(ours.updatedAt[f], theirs.updatedAt[f])) {
      set[f] = ours[f];
      out.updatedAt[f] = ours.updatedAt[f];
    }
  }
  return out;
}

/**
 * brain/members.json: union by installId, the earlier `joinedAt` (and its row) kept; a member the base had and one
 * side took out (they left) stays out, unless the other side has them joined again.
 */
export function mergeMembers(
  ours: Members,
  theirs: Members,
  base: Members | null = null,
): Members {
  const row = (list: Members, id: string) =>
    list.members.find((m) => m.installId === id);
  // Out on one side, unchanged on the other: they left. A new joinedAt on the other side is a join again.
  const left = new Set(
    (base?.members ?? [])
      .filter((b) => {
        const o = row(ours, b.installId);
        const t = row(theirs, b.installId);
        return (
          (!o && (!t || t.joinedAt === b.joinedAt)) ||
          (!t && (!o || o.joinedAt === b.joinedAt))
        );
      })
      .map((b) => b.installId),
  );
  const byId = new Map<string, Members['members'][number]>();
  for (const m of [...ours.members, ...theirs.members]) {
    if (left.has(m.installId)) continue;
    const have = byId.get(m.installId);
    if (!have || after(have.joinedAt, m.joinedAt)) byId.set(m.installId, m);
  }
  return { format: 1, members: [...byId.values()] };
}
