import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionDoc, Task } from '../../shared/types';
import { activeWorkspaces } from '../../shared/workspaces';
import { isFile } from '../fsRetry';
import { isInside, samePath } from '../paths';
import type { GitClient } from '../services/GitClient';
import { claudeProjectFolder } from '../services/claudeSessions';
import { SessionLogReader } from '../workspaces/sessionLog';
import { toRel } from '../paths';
import { changedDocs, MD, TASK_FILE } from './worktreeFiles';

const EDIT_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};
const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;
/** Chunks read per transcript per refresh (each at most MAX_READ_BYTES), so a huge log catches up over a few refreshes. */
const MAX_CHUNKS = 8;
/** Session docs kept per task; a session that wrote more is not a docs session. */
const MAX_SESSION_DOCS = 500;
/** How long a git scan of the worktrees is reused; a change the DocsWatcher sees drops it sooner. */
const GIT_TTL_MS = 5000;
/** How long a computed list answers whitelist checks (docs:read polls every 2 s). */
const LIST_TTL_MS = 1500;
/** How often all of Claude's project folders are searched for a session id not found in the expected one. */
const SCAN_ALL_MS = 30_000;

export type SessionEdit = { path: string; at: number };

/** A tool's file path made absolute; Windows-style paths follow win32 rules on any platform. Null when it cannot be placed. */
export function absoluteIn(p: string, cwd: string | null): string | null {
  if (WIN_ABS.test(p)) return path.win32.resolve(p);
  if (cwd && WIN_ABS.test(cwd)) return path.win32.resolve(cwd, p);
  if (path.isAbsolute(p)) return path.resolve(p);
  return cwd ? path.resolve(cwd, p) : null;
}

/** The Markdown files Claude Code's Write, Edit, MultiEdit and NotebookEdit calls touched, from transcript lines. Malformed lines are skipped. */
export function mdEditsFromLines(lines: string[]): SessionEdit[] {
  const out: SessionEdit[] = [];
  for (const line of lines) {
    // Cheap filters first: most lines are tool results, text or images.
    if (!line.includes('"tool_use"') || !/\.(md|markdown)"/i.test(line))
      continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content))
      continue;
    const cwd = typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : null;
    const at =
      typeof entry.timestamp === 'string'
        ? Date.parse(entry.timestamp) || 0
        : 0;
    for (const block of entry.message.content) {
      if (block?.type !== 'tool_use' || !block.input) continue;
      const key = EDIT_TOOLS[block.name];
      const p = key ? block.input[key] : undefined;
      if (typeof p !== 'string' || !p || p.includes('\0')) continue;
      const abs = absoluteIn(p, cwd);
      if (abs && MD.test(abs)) out.push({ path: abs, at });
    }
  }
  return out;
}

/** A path with "/" separators, as the renderer keeps it. */
export const toSlash = (p: string): string => p.split('\\').join('/');

const isAbsoluteAny = (p: string) => WIN_ABS.test(p) || path.isAbsolute(p);

/** Main's view of a session doc: its real path on disk next to what the renderer gets. */
export type SessionEntry = SessionDoc & { real: string };

export type SessionDocsDeps = {
  git: GitClient;
  /** Claude Code's projects folder (`claudeProjectsDir()`). */
  projectsDir: () => string;
  reader?: SessionLogReader;
  now?: () => number;
};

/**
 * The task's session docs: Markdown its Claude Code sessions wrote (from the transcripts, read incrementally) and
 * Markdown changed in its worktrees. Also the whitelist for reading files outside the worktrees.
 */
export class SessionDocs {
  private readonly reader: SessionLogReader;
  private readonly now: () => number;
  /** Edits per transcript file, keyed by path. */
  private readonly edits = new Map<string, Map<string, SessionEdit>>();
  private readonly gitCache = new Map<
    string,
    {
      at: number;
      files: {
        workspaceId: string;
        abs: string;
        rel: string;
        changed: 'new' | 'modified';
      }[];
    }
  >();
  private readonly lists = new Map<
    string,
    { at: number; run: Promise<SessionEntry[]> }
  >();
  /** Where a session id's transcript was found. */
  private readonly sessionFiles = new Map<string, string>();
  private lastScanAll = 0;

  constructor(private readonly d: SessionDocsDeps) {
    this.reader = d.reader ?? new SessionLogReader();
    this.now = d.now ?? Date.now;
  }

  /** A worktree changed: the next list scans git again. */
  invalidate(taskId: string): void {
    this.gitCache.delete(taskId);
    this.lists.delete(taskId);
  }

  /** The task's session docs that exist now, sorted by path. */
  list(task: Task): Promise<SessionEntry[]> {
    const run = this.compute(task);
    this.lists.set(task.id, { at: this.now(), run });
    run.catch(() => this.lists.delete(task.id));
    return run;
  }

  /** The session doc at `p` (absolute), or null: the whitelist for reading outside the task's worktrees. */
  async find(task: Task, p: string): Promise<SessionEntry | null> {
    if (!p || p.includes('\0') || !isAbsoluteAny(p)) return null;
    let real: string;
    try {
      real = await fs.realpath(path.resolve(p));
    } catch {
      return null;
    }
    const entries = await this.recent(task);
    return entries.find((e) => samePath(e.real, real)) ?? null;
  }

  /**
   * The real path of an image `p` inside the folder of a session doc outside the worktrees, or null. Relative
   * images in such a doc resolve against its own folder and may not leave that folder's tree.
   */
  async assetPath(task: Task, p: string): Promise<string | null> {
    if (!p || p.includes('\0') || !isAbsoluteAny(p)) return null;
    let real: string;
    try {
      real = await fs.realpath(path.resolve(p));
    } catch {
      return null;
    }
    const entries = await this.recent(task);
    const ok = entries.some((e) => {
      if (e.workspaceId !== null) return false;
      const dir = path.dirname(e.real);
      // A doc at a drive or filesystem root does not open the whole disk.
      return path.parse(dir).root !== dir && isInside(dir, real);
    });
    return ok ? real : null;
  }

  private recent(task: Task): Promise<SessionEntry[]> {
    const l = this.lists.get(task.id);
    return l && this.now() - l.at < LIST_TTL_MS ? l.run : this.list(task);
  }

  private async compute(task: Task): Promise<SessionEntry[]> {
    const workspaces = activeWorkspaces(task).filter((w) => w.worktreePath);
    const roots = await Promise.all(
      workspaces.map(async (w) => ({
        w,
        real: await fs.realpath(w.worktreePath).catch(() => null),
      })),
    );
    const byKey = new Map<string, SessionEntry>();
    const add = async (
      abs: string,
      at: { claude?: boolean; changed?: 'new' | 'modified' | null },
    ) => {
      let real: string;
      let mtimeMs: number;
      try {
        real = await fs.realpath(abs);
        const st = await fs.stat(real);
        if (!st.isFile()) return;
        mtimeMs = st.mtimeMs;
      } catch {
        return; // gone since
      }
      const key = process.platform === 'win32' ? real.toLowerCase() : real;
      const had = byKey.get(key);
      if (had) {
        had.claude ||= !!at.claude;
        had.changed ??= at.changed ?? null;
        return;
      }
      const root = roots.find((r) => r.real && isInside(r.real, real));
      const rel = root?.real ? toRel(root.real, real) : null;
      byKey.set(key, {
        path: rel ?? toSlash(abs),
        workspaceId: root ? root.w.id : null,
        changed: at.changed ?? null,
        claude: !!at.claude,
        mtimeMs,
        real,
      });
    };
    const edits = await this.claudeEdits(task);
    const changed = await this.gitChanges(task);
    for (const e of edits.slice(0, MAX_SESSION_DOCS))
      await add(e.path, { claude: true });
    for (const c of changed.slice(0, MAX_SESSION_DOCS))
      await add(c.abs, { changed: c.changed });
    return [...byKey.values()]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, MAX_SESSION_DOCS);
  }

  /** Every Markdown edit in the task's transcripts, newest first, one per path. */
  private async claudeEdits(task: Task): Promise<SessionEdit[]> {
    const files = await this.transcripts(task);
    const merged = new Map<string, SessionEdit>();
    for (const file of files) {
      let mine = this.edits.get(file);
      if (!mine) this.edits.set(file, (mine = new Map()));
      for (let i = 0; i < MAX_CHUNKS; i++) {
        for (const e of mdEditsFromLines(await this.reader.readNew(file)))
          mine.set(e.path, e);
        if (!this.reader.behind(file)) break;
      }
      for (const [k, e] of mine) {
        const had = merged.get(k);
        if (!had || had.at < e.at) merged.set(k, e);
      }
    }
    return [...merged.values()].sort((a, b) => b.at - a.at);
  }

  /**
   * The task's transcripts: each Claude tab's session (by id), plus every transcript Claude saved for one of the
   * task's worktrees since the task was created (tabs from before session ids, `claude` run by hand in a shell,
   * a resume that forked the session).
   */
  private async transcripts(task: Task): Promise<string[]> {
    const dir = this.d.projectsDir();
    const out = new Set<string>();
    const since = Date.parse(task.createdAt) || 0;
    const folders = new Set<string>();
    for (const w of activeWorkspaces(task)) {
      folders.add(claudeProjectFolder(w.worktreePath));
      const real = await fs.realpath(w.worktreePath).catch(() => null);
      if (real) folders.add(claudeProjectFolder(real));
    }
    for (const f of folders) {
      const folder = path.join(dir, f);
      let names: string[];
      try {
        names = (await fs.readdir(folder)).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const n of names) {
        const file = path.join(folder, n);
        const st = await fs.stat(file).catch(() => null);
        if (st?.isFile() && st.mtimeMs >= since) out.add(file);
      }
    }
    const ids = new Set(
      [...task.terminals, ...task.closedTerminals]
        .filter((t) => t.kind === 'claude' && t.sessionId)
        .map((t) => t.sessionId as string),
    );
    const missing: string[] = [];
    for (const id of ids) {
      const known = this.sessionFiles.get(id);
      if (known) {
        out.add(known);
        continue;
      }
      let found: string | null = null;
      for (const f of folders) {
        const file = path.join(dir, f, `${id}.jsonl`);
        if (await isFile(file)) {
          found = file;
          break;
        }
      }
      if (found) {
        this.sessionFiles.set(id, found);
        out.add(found);
      } else missing.push(id);
    }
    // Claude may name the folder differently (a long cwd is shortened): look everywhere, now and then.
    if (missing.length > 0 && this.now() - this.lastScanAll >= SCAN_ALL_MS) {
      this.lastScanAll = this.now();
      const all = await fs.readdir(dir).catch(() => [] as string[]);
      for (const id of missing)
        for (const f of all) {
          const file = path.join(dir, f, `${id}.jsonl`);
          if (await isFile(file)) {
            this.sessionFiles.set(id, file);
            out.add(file);
            break;
          }
        }
    }
    return [...out];
  }

  private async gitChanges(task: Task) {
    const cached = this.gitCache.get(task.id);
    if (cached && this.now() - cached.at < GIT_TTL_MS) return cached.files;
    const files: {
      workspaceId: string;
      abs: string;
      rel: string;
      changed: 'new' | 'modified';
    }[] = [];
    for (const w of activeWorkspaces(task)) {
      let changed: Map<string, 'new' | 'modified'>;
      try {
        changed = await changedDocs(
          this.d.git,
          w.worktreePath,
          w.baseSha ?? 'HEAD',
        );
      } catch {
        continue; // a missing or broken worktree has no changes to show
      }
      for (const [rel, c] of changed)
        if (rel !== TASK_FILE)
          files.push({
            workspaceId: w.id,
            abs: path.join(w.worktreePath, rel),
            rel,
            changed: c,
          });
    }
    this.gitCache.set(task.id, { at: this.now(), files });
    return files;
  }
}

/** What the renderer gets. */
export const toWire = ({ real: _real, ...doc }: SessionEntry): SessionDoc =>
  doc;
