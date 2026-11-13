/**
 * Merges the server's branch into a brain folder so no person ever sees a git conflict: git's own three-way merge
 * where it is clean, the rule table of the shared-brains spec ("Sync") for every path it is not. Job output that
 * lost a clash is reported so the job runs again on the merged brain.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { BrainStateSchema, type BrainBook } from '../../../shared/brain';
import { MembersSchema, SharedFactsSchema } from '../../../shared/brainShare';
import type { GitClient } from '../../services/GitClient';
import {
  isPersonFree,
  MERGE_MESSAGE,
  parseJobSubject,
  SCRUB_MESSAGE,
  type JobRef,
} from '../brainCommits';
import type { ConflictsFile } from '../conflicts';
import { rebuildIndex } from '../indexPage';
import { pathExists } from '../../fsRetry';
import { absPath } from '../paths';
import { REDACTED } from '../scrub';
import { renderSource, sha256, slugify, sourceFileName } from '../sourceFile';
import { isAncestor, isRecord } from './gitUtil';
import {
  mergeBook,
  mergeConflicts,
  mergeKeyedMap,
  mergeLog,
  mergeMembers,
  mergeShared,
  mergeState,
} from './jsonMerge';

export type MergeResult = { merged: boolean; rerun: JobRef[]; notes: string[] };

const RAW = ['-c', 'core.quotepath=off'];

/** The template files the skills live in: the side with the higher `templatesVersion` wins them. */
const isSkillsPath = (p: string) =>
  p === 'SCHEMA.md' ||
  p === 'opencode.json' ||
  p === '.gitignore' ||
  p.startsWith('.claude/') ||
  p.startsWith('.opencode/');

const jsonText = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * Merges `ref` (the server's branch, fetched) into the brain at `dir`. Runs inside the caller's `withBrainGit`.
 * Every conflicted path is resolved by rule and the merge is committed as `Brain: merge from colleagues`; a merge
 * with nothing local fast-forwards. Throws only when git fails for another reason, after `git merge --abort`.
 */
export async function mergeServer(
  git: GitClient,
  dir: string,
  ref: string,
  now: Date = new Date(),
): Promise<MergeResult> {
  const nothing: MergeResult = { merged: false, rerun: [], notes: [] };
  const theirsId = (
    await git.run(dir, ['rev-parse', '--verify', `${ref}^{commit}`])
  ).trim();
  if (await isAncestor(git, dir, theirsId, 'HEAD')) return nothing;
  if (await isAncestor(git, dir, 'HEAD', theirsId)) {
    await git.run(dir, ['merge', '-q', '--ff-only', theirsId]);
    return { merged: true, rerun: [], notes: [] };
  }

  const base = (await git.run(dir, ['merge-base', 'HEAD', theirsId])).trim();
  try {
    await git
      .run(dir, ['merge', '-q', '--no-ff', '--no-commit', theirsId])
      .catch(async (e: unknown) => {
        // A conflict is ours to resolve; any other failure is not.
        if (!(await unmerged(git, dir)).size) throw e;
      });
    const r = await resolveConflicts(git, dir, base, theirsId, now);
    // Shellie owns index.md: rebuilt from the merged pages, whichever side it came from.
    if (await rebuildIndex(dir, 'Brain'))
      await git.run(dir, ['add', '--', 'index.md']);
    await git.run(dir, ['commit', '-q', '--no-verify', '-m', MERGE_MESSAGE]);
    return { merged: true, ...r };
  } catch (e) {
    await git.run(dir, ['merge', '--abort']).catch(() => undefined);
    throw e;
  }
}

/** Each conflicted path with the index stages it has (1 base, 2 ours, 3 theirs). */
async function unmerged(
  git: GitClient,
  dir: string,
): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();
  const raw = await git.run(dir, [...RAW, 'ls-files', '-u', '-z']);
  for (const entry of raw.split('\0')) {
    const m = /^\d+ [0-9a-f]+ ([123])\t(.+)$/s.exec(entry);
    if (!m) continue;
    const stages = out.get(m[2]) ?? new Set<number>();
    stages.add(Number(m[1]));
    out.set(m[2], stages);
  }
  return out;
}

/** The three sides of a conflicted JSON file, parsed (a missing side is null). */
type JsonSides = { base: unknown; ours: unknown; theirs: unknown };
type JsonRule = (
  s: JsonSides,
  git: GitClient,
  dir: string,
) => unknown | Promise<unknown>;

/** A map of keyed records (`{ at }` each), merged key by key. */
const keyedMap = (v: unknown) =>
  (isRecord(v) ? v : {}) as Record<string, { at?: string }>;
const keyedMapRule: JsonRule = ({ ours, theirs }) =>
  mergeKeyedMap(keyedMap(ours), keyedMap(theirs));

/** The brain's own JSON files, each merged by its rule of the spec's table. */
const JSON_RULES: Record<string, JsonRule> = {
  'brain/state.json': async ({ base, ours, theirs }, git, dir) => {
    const o = BrainStateSchema.parse(ours);
    const t = BrainStateSchema.parse(theirs);
    const b =
      base === null ? null : (BrainStateSchema.safeParse(base).data ?? null);
    // mergeState asks synchronously: settle the two commits' ancestry with git first.
    const known = new Map<string, boolean>();
    const pair = [o.lastSyncCommit, t.lastSyncCommit];
    if (pair[0] && pair[1])
      for (const [x, y] of [pair, [pair[1], pair[0]]] as [string, string][])
        known.set(`${x} ${y}`, await isAncestor(git, dir, x, y));
    const merged = mergeState(
      b,
      o,
      t,
      (x, y) => known.get(`${x} ${y}`) ?? false,
    );
    // Keys the schema does not know (a newer Shellie's) are kept, as writeState keeps them.
    return { ...(theirs as object), ...merged };
  },
  'brain/conflicts.json': ({ ours, theirs }) => {
    const file = (v: unknown): ConflictsFile => ({
      version: 1,
      conflicts:
        isRecord(v) && isRecord(v.conflicts)
          ? (v.conflicts as ConflictsFile['conflicts'])
          : {},
    });
    return mergeConflicts(file(ours), file(theirs));
  },
  'brain/reads.json': ({ ours, theirs }) => {
    const reads = (v: unknown) => keyedMap(isRecord(v) ? v.reads : null);
    return {
      ...(theirs as object),
      reads: mergeKeyedMap(reads(ours), reads(theirs)),
    };
  },
  'brain/pictures-skipped.json': keyedMapRule,
  'brain/pictures-dropped.json': keyedMapRule,
  'brain/book.json': ({ ours, theirs }) => {
    const book = (v: unknown): BrainBook => ({
      chapters:
        isRecord(v) && Array.isArray(v.chapters)
          ? (v.chapters as BrainBook['chapters'])
          : [],
    });
    return mergeBook(book(ours), book(theirs));
  },
  'brain/shared.json': ({ ours, theirs }) =>
    mergeShared(SharedFactsSchema.parse(ours), SharedFactsSchema.parse(theirs)),
  'brain/members.json': ({ base, ours, theirs }) =>
    mergeMembers(
      MembersSchema.parse(ours),
      MembersSchema.parse(theirs),
      base === null ? null : (MembersSchema.safeParse(base).data ?? null),
    ),
};

/** Resolves one conflicted path; the context the rules share. */
type Conflict = {
  git: GitClient;
  dir: string;
  /** The merge base. */
  base: string;
  now: Date;
  stages: Set<number>;
  stage: (n: 1 | 2 | 3) => Promise<string | null>;
  take: (side: 'ours' | 'theirs') => Promise<void>;
  put: (text: string) => Promise<void>;
  skillsWinner: () => Promise<'ours' | 'theirs'>;
  rerun: JobRef[];
  notes: string[];
};

/** The other paths, by prefix or test, in order: the first that matches resolves it. */
const PATH_RULES: [
  (p: string) => boolean,
  (p: string, c: Conflict) => Promise<void>,
][] = [
  // Rebuilt from the pages after the merge.
  [(p) => p === 'index.md', (_, c) => c.take('theirs')],
  [isSkillsPath, async (_, c) => c.take(await c.skillsWinner())],
  // The mirror: the next refresh brings either side up to date.
  [(p) => p.startsWith('sources/wiki/'), (_, c) => c.take('theirs')],
  [
    (p) => p.startsWith('sources/'),
    (p, c) => keepBothSources(c.git, c.dir, p, c.stages),
  ],
  [(p) => p.startsWith('wiki/') || p.startsWith('reads/'), resolvePage],
];

async function resolveConflicts(
  git: GitClient,
  dir: string,
  base: string,
  theirsId: string,
  now: Date,
): Promise<{ rerun: JobRef[]; notes: string[] }> {
  const rerun: JobRef[] = [];
  const notes: string[] = [];
  const conflicted = await unmerged(git, dir);
  if (!conflicted.size) return { rerun, notes };

  let skillsSide: 'ours' | 'theirs' | null = null;
  const skillsWinner = async () => {
    if (skillsSide) return skillsSide;
    const version = async (rev: string) => {
      const text = await git
        .run(dir, ['show', `${rev}:brain/shared.json`])
        .catch(() => null);
      if (text === null) return 0;
      const r = SharedFactsSchema.safeParse(JSON.parse(text));
      return r.success ? r.data.templatesVersion : 0;
    };
    skillsSide =
      (await version('HEAD')) > (await version(theirsId)) ? 'ours' : 'theirs';
    return skillsSide;
  };

  for (const p of [...conflicted.keys()].sort()) {
    const stages = conflicted.get(p) ?? new Set<number>();
    const c: Conflict = {
      git,
      dir,
      base,
      now,
      stages,
      stage: (n) =>
        stages.has(n)
          ? git.run(dir, [...RAW, 'show', `:${n}:${p}`])
          : Promise.resolve(null),
      take: async (side) => {
        if (stages.has(side === 'ours' ? 2 : 3)) {
          await git.run(dir, ['checkout', `--${side}`, '--', p]);
          await git.run(dir, ['add', '--', p]);
        } else {
          await git.run(dir, ['rm', '-q', '-f', '--', p]);
        }
      },
      put: async (text) => {
        await fs.writeFile(absPath(dir, p), text);
        await git.run(dir, ['add', '--', p]);
      },
      skillsWinner,
      rerun,
      notes,
    };
    const json = JSON_RULES[p];
    if (p === 'log.md') {
      const [ours, theirs] = await Promise.all([c.stage(2), c.stage(3)]);
      await c.put(mergeLog(ours ?? '', theirs ?? ''));
    } else if (json) {
      // Both sides parsed (a side that is not JSON throws); a side missing takes the side that has it.
      const [b, o, t] = await Promise.all([c.stage(1), c.stage(2), c.stage(3)]);
      const parse = (x: string | null): unknown =>
        x === null ? null : JSON.parse(x);
      const s = { base: parse(b), ours: parse(o), theirs: parse(t) };
      if (s.ours === null || s.theirs === null)
        await c.take(s.theirs === null ? 'ours' : 'theirs');
      else await c.put(jsonText(await json(s, git, dir)));
    } else {
      const rule = PATH_RULES.find(([match]) => match(p));
      // Not in the rule table (brain/origin.json, anything new): the server's side.
      if (rule) await rule[1](p, c);
      else await c.take('theirs');
    }
  }
  return { rerun, notes };
}

/**
 * A wiki page or a long read both sides changed: the server's side, and the jobs whose output lost run again; an
 * outside edit of ours becomes a note source. A page a scrub of ours took a value out of stays ours while the
 * server's side still holds that value.
 */
async function resolvePage(p: string, c: Conflict): Promise<void> {
  const { git, dir } = c;
  const ours = await c.stage(2);
  const log = (
    await git.run(dir, [
      ...RAW,
      'log',
      '--no-merges',
      `${c.base}..HEAD`,
      '--format=%H %s',
      '--',
      p,
    ])
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => ({
      id: l.slice(0, l.indexOf(' ')),
      subject: l.slice(l.indexOf(' ') + 1),
    }));
  // A scrub took a value out here: a server page that still holds it would bring it back, so ours stays.
  const scrubs = log.filter((x) => x.subject === SCRUB_MESSAGE);
  const theirs = scrubs.length ? await c.stage(3) : null;
  if (
    theirs !== null &&
    (
      await scrubbedValues(
        git,
        dir,
        scrubs.map((x) => x.id),
        p,
      )
    ).some((v) => theirs.includes(v))
  ) {
    await c.take('ours');
    return;
  }
  await c.take('theirs');
  let outsideEdit = false;
  for (const { subject } of log) {
    const job = parseJobSubject(subject);
    if (!job) outsideEdit ||= !isPersonFree(subject);
    else if (!c.rerun.some((r) => sameJob(r, job))) c.rerun.push(job);
  }
  if (outsideEdit && ours !== null)
    c.notes.push(await writeLocalNote(git, dir, p, ours, c.now));
}

const sameJob = (a: JobRef, b: JobRef) =>
  a.kind === b.kind && a.source === b.source && a.target === b.target;

/**
 * Sources are never edited, but if one clashes, both stay: the server's at its path, ours as `<name>-local<ext>` (or
 * the first free `-local-<n>`).
 */
async function keepBothSources(
  git: GitClient,
  dir: string,
  p: string,
  stages: Set<number>,
): Promise<void> {
  if (!stages.has(3)) {
    await git.run(dir, ['checkout', '--ours', '--', p]);
    await git.run(dir, ['add', '--', p]);
    return;
  }
  if (stages.has(2)) {
    const ext = path.posix.extname(p);
    const stem = p.slice(0, p.length - ext.length);
    // Never over a file of that name (either side's): -local, then -local-2, -local-3…
    let local = `${stem}-local${ext}`;
    for (let n = 2; await pathExists(absPath(dir, local)); n++)
      local = `${stem}-local-${n}${ext}`;
    await git.run(dir, ['checkout', '--ours', '--', p]);
    await fs.rename(absPath(dir, p), absPath(dir, local));
    await git.run(dir, ['add', '--', local]);
  }
  await git.run(dir, ['checkout', '--theirs', '--', p]);
  await git.run(dir, ['add', '--', p]);
}

/**
 * The values `Brain: scrub` commits took out of `p`: per changed line, the part of the old line its REDACTED
 * replaced (the whole old line when the two cannot be lined up). Six characters at least, as the scrub asks.
 */
async function scrubbedValues(
  git: GitClient,
  dir: string,
  commits: string[],
  p: string,
): Promise<string[]> {
  const values: string[] = [];
  for (const c of commits) {
    const diff = await git.run(dir, [
      ...RAW,
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U0',
      `${c}^`,
      c,
      '--',
      p,
    ]);
    let removed: string[] = [];
    let added: string[] = [];
    const flush = () => {
      removed.forEach((r, i) => {
        const a = added[i];
        let v = r;
        if (a !== undefined && a.includes(REDACTED)) {
          let start = 0;
          while (start < r.length && start < a.length && r[start] === a[start])
            start++;
          let end = 0;
          while (
            end < r.length - start &&
            end < a.length - start &&
            r[r.length - 1 - end] === a[a.length - 1 - end]
          )
            end++;
          v = r.slice(start, r.length - end);
        }
        if (v.trim().length >= 6) values.push(v.trim());
      });
      removed = [];
      added = [];
    };
    let inHunk = false;
    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git ')) inHunk = false;
      else if (line.startsWith('@@')) {
        flush();
        inHunk = true;
      } else if (!inHunk) continue;
      else if (line.startsWith('-')) removed.push(line.slice(1));
      else if (line.startsWith('+')) added.push(line.slice(1));
    }
    flush();
  }
  return values;
}

/** Our text of a page or read the server's version replaced, as a note source a capture folds back in. */
async function writeLocalNote(
  git: GitClient,
  dir: string,
  page: string,
  text: string,
  now: Date,
): Promise<string> {
  const notesDir = absPath(dir, 'sources/notes');
  await fs.mkdir(notesDir, { recursive: true });
  const taken = new Set(await fs.readdir(notesDir));
  const slug = slugify(path.posix.basename(page)) || 'page';
  const name = sourceFileName(now, `${slug}-local`, taken);
  const rel = `sources/notes/${name}`;
  const title = `Local edit of ${page}`;
  await fs.writeFile(
    absPath(dir, rel),
    renderSource(
      {
        title,
        source_url: page,
        ingested_at: now.toISOString(),
        content_type: 'note',
        sha256: sha256(text),
        note: `My edit to ${page} clashed with a colleague's change to it, and theirs was kept. Fold what this edit adds into the wiki.`,
      },
      text.trimEnd() + '\n',
    ),
  );
  await git.run(dir, ['add', '--', rel]);
  return rel;
}
