/**
 * Merges the server's branch into a brain folder so no person ever sees a git conflict: git's own three-way merge
 * where it is clean, the rule table of the shared-brains spec ("Sync") for every path it is not. Job output that
 * lost a clash is reported so the job runs again on the merged brain.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BrainStateSchema,
  SOURCE_JOB_KINDS,
  type BrainBook,
  type BrainJobKind,
} from '../../../shared/brain';
import { MembersSchema, SharedFactsSchema } from '../../../shared/brainShare';
import type { GitClient } from '../../services/GitClient';
import type { ConflictsFile } from '../conflicts';
import { rebuildIndex } from '../indexPage';
import { absPath } from '../paths';
import { renderSource, sha256, slugify, sourceFileName } from '../sourceFile';
import {
  mergeBook,
  mergeConflicts,
  mergeKeyedMap,
  mergeLog,
  mergeMembers,
  mergeShared,
  mergeState,
} from './jsonMerge';

export type JobRef = {
  kind: BrainJobKind;
  source: string | null;
  target: string | null;
};

export type MergeResult = { merged: boolean; rerun: JobRef[]; notes: string[] };

export const MERGE_MESSAGE = 'Brain: merge from colleagues';

const JOB_KINDS: ReadonlySet<string> = new Set<BrainJobKind>([
  'capture',
  'sync',
  'lint',
  'digest',
  'retract',
  'lessons',
  'pictures',
  'settle',
  'write',
]);

/**
 * The job a commit subject came from (`runSkill`'s `Brain: <kind>[ <source or target>]`), or null for any other
 * commit: an outside edit, `Brain: index`, `Brain: settle conflict`.
 */
export function parseJobSubject(subject: string): JobRef | null {
  const m = /^Brain: ([a-z]+)(?: (.+))?$/.exec(subject.trim());
  if (!m || !JOB_KINDS.has(m[1])) return null;
  const kind = m[1] as BrainJobKind;
  const rest = m[2] ?? null;
  if (rest === null) return { kind, source: null, target: null };
  if (kind === 'write') return { kind, source: null, target: rest };
  if (SOURCE_JOB_KINDS.has(kind) && rest.startsWith('sources/'))
    return { kind, source: rest, target: null };
  return null;
}

const RAW = ['-c', 'core.quotepath=off'];

/** The template files the skills live in: the side with the higher `templatesVersion` wins them. */
const isSkillsPath = (p: string) =>
  p === 'SCHEMA.md' ||
  p === 'opencode.json' ||
  p === '.gitignore' ||
  p.startsWith('.claude/') ||
  p.startsWith('.opencode/');

const jsonText = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

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
  const isAncestor = (a: string, b: string) =>
    git.run(dir, ['merge-base', '--is-ancestor', a, b]).then(
      () => true,
      () => false,
    );
  const theirsId = (
    await git.run(dir, ['rev-parse', '--verify', `${ref}^{commit}`])
  ).trim();
  if (await isAncestor(theirsId, 'HEAD')) return nothing;
  if (await isAncestor('HEAD', theirsId)) {
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

  const stage = (p: string, n: 1 | 2 | 3) =>
    conflicted.get(p)?.has(n)
      ? git.run(dir, [...RAW, 'show', `:${n}:${p}`])
      : Promise.resolve(null);
  const take = async (p: string, side: 'ours' | 'theirs') => {
    if (conflicted.get(p)?.has(side === 'ours' ? 2 : 3)) {
      await git.run(dir, ['checkout', `--${side}`, '--', p]);
      await git.run(dir, ['add', '--', p]);
    } else {
      await git.run(dir, ['rm', '-q', '-f', '--', p]);
    }
  };
  const put = async (p: string, text: string) => {
    await fs.writeFile(absPath(dir, p), text);
    await git.run(dir, ['add', '--', p]);
  };
  /** Both sides parsed as JSON (a missing side is null); a side that is not JSON throws. */
  const sides = async (p: string) => {
    const parse = (t: string | null): unknown =>
      t === null ? null : JSON.parse(t);
    return {
      base: parse(await stage(p, 1)),
      ours: parse(await stage(p, 2)),
      theirs: parse(await stage(p, 3)),
    };
  };
  /** Merges a JSON file with `fn` when both sides have it; otherwise the side that has it. */
  const mergeJson = async (
    p: string,
    fn: (s: {
      base: unknown;
      ours: unknown;
      theirs: unknown;
    }) => unknown | Promise<unknown>,
  ) => {
    const s = await sides(p);
    if (s.ours === null || s.theirs === null)
      return take(p, s.theirs === null ? 'ours' : 'theirs');
    await put(p, jsonText(await fn(s)));
  };

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
    if (p === 'log.md') {
      await put(
        p,
        mergeLog(
          await stage(p, 1),
          (await stage(p, 2)) ?? '',
          (await stage(p, 3)) ?? '',
        ),
      );
    } else if (p === 'brain/state.json') {
      await mergeJson(p, async ({ base, ours, theirs }) => {
        const o = BrainStateSchema.parse(ours);
        const t = BrainStateSchema.parse(theirs);
        const b =
          base === null
            ? null
            : (BrainStateSchema.safeParse(base).data ?? null);
        // mergeState asks synchronously: settle the two commits' ancestry with git first.
        const known = new Map<string, boolean>();
        const pair = [o.lastSyncCommit, t.lastSyncCommit];
        if (pair[0] && pair[1])
          for (const [x, y] of [pair, [pair[1], pair[0]]] as [string, string][])
            known.set(
              `${x} ${y}`,
              await git.run(dir, ['merge-base', '--is-ancestor', x, y]).then(
                () => true,
                () => false,
              ),
            );
        const merged = mergeState(
          b,
          o,
          t,
          (x, y) => known.get(`${x} ${y}`) ?? false,
        );
        // Keys the schema does not know (a newer Shellie's) are kept, as writeState keeps them.
        return { ...(theirs as object), ...merged };
      });
    } else if (p === 'brain/conflicts.json') {
      await mergeJson(p, ({ ours, theirs }) => {
        const file = (v: unknown): ConflictsFile => ({
          version: 1,
          conflicts:
            isRecord(v) && isRecord(v.conflicts)
              ? (v.conflicts as ConflictsFile['conflicts'])
              : {},
        });
        return mergeConflicts(file(ours), file(theirs));
      });
    } else if (p === 'brain/reads.json') {
      await mergeJson(p, ({ ours, theirs }) => {
        const map = (v: unknown) =>
          (isRecord(v) && isRecord(v.reads) ? v.reads : {}) as Record<
            string,
            { at?: string }
          >;
        return {
          ...(theirs as object),
          reads: mergeKeyedMap(map(ours), map(theirs)),
        };
      });
    } else if (
      p === 'brain/pictures-skipped.json' ||
      p === 'brain/pictures-dropped.json'
    ) {
      await mergeJson(p, ({ ours, theirs }) => {
        const map = (v: unknown) =>
          (isRecord(v) ? v : {}) as Record<string, { at?: string }>;
        return mergeKeyedMap(map(ours), map(theirs));
      });
    } else if (p === 'brain/book.json') {
      await mergeJson(p, ({ ours, theirs }) => {
        const book = (v: unknown): BrainBook => ({
          chapters:
            isRecord(v) && Array.isArray(v.chapters)
              ? (v.chapters as BrainBook['chapters'])
              : [],
        });
        return mergeBook(book(ours), book(theirs));
      });
    } else if (p === 'brain/shared.json') {
      await mergeJson(p, ({ ours, theirs }) =>
        mergeShared(
          SharedFactsSchema.parse(ours),
          SharedFactsSchema.parse(theirs),
        ),
      );
    } else if (p === 'brain/members.json') {
      await mergeJson(p, ({ ours, theirs }) =>
        mergeMembers(MembersSchema.parse(ours), MembersSchema.parse(theirs)),
      );
    } else if (p === 'index.md') {
      // Rebuilt from the pages after the merge.
      await take(p, 'theirs');
    } else if (isSkillsPath(p)) {
      await take(p, await skillsWinner());
    } else if (p.startsWith('sources/wiki/')) {
      // The mirror: the next refresh brings either side up to date.
      await take(p, 'theirs');
    } else if (p.startsWith('sources/')) {
      await keepBothSources(git, dir, p, conflicted.get(p) ?? new Set());
    } else if (p.startsWith('wiki/') || p.startsWith('reads/')) {
      const ours = await stage(p, 2);
      await take(p, 'theirs');
      const subjects = (
        await git.run(dir, [
          ...RAW,
          'log',
          `${base}..HEAD`,
          '--format=%s',
          '--',
          p,
        ])
      )
        .split('\n')
        .filter(Boolean);
      let outsideEdit = false;
      for (const s of subjects) {
        const job = parseJobSubject(s);
        if (!job) outsideEdit = true;
        else if (!rerun.some((r) => sameJob(r, job))) rerun.push(job);
      }
      if (outsideEdit && ours !== null)
        notes.push(await writeLocalNote(git, dir, p, ours, now));
    } else {
      // Not in the rule table (brain/origin.json, anything new): the server's side.
      await take(p, 'theirs');
    }
  }
  return { rerun, notes };
}

const sameJob = (a: JobRef, b: JobRef) =>
  a.kind === b.kind && a.source === b.source && a.target === b.target;

/** Sources are never edited, but if one clashes, both stay: the server's at its path, ours as `<name>-local<ext>`. */
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
    const local = `${p.slice(0, p.length - ext.length)}-local${ext}`;
    await git.run(dir, ['checkout', '--ours', '--', p]);
    await fs.rename(absPath(dir, p), absPath(dir, local));
    await git.run(dir, ['add', '--', local]);
  }
  await git.run(dir, ['checkout', '--theirs', '--', p]);
  await git.run(dir, ['add', '--', p]);
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
