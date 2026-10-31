import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Handlers } from '../../shared/ipc';
import type { TelemetryProps } from '../../shared/telemetry';
import type { Task } from '../../shared/types';
import {
  activeHome,
  activeWorkspaces,
  parseDocsTarget,
  type WorkspaceView,
  workspaceById,
} from '../../shared/workspaces';
import type { GitClient } from '../services/GitClient';
import { requireWorktree, watchableWorkspace } from '../workspaces/existing';
import type { DocsWatcher } from './DocsWatcher';
import { type SessionDocs, toSlash, toWire } from './sessionDocs';
import {
  listDocs,
  readAsset,
  readDoc,
  readImage,
  readText,
  HTML,
  resolveInWorktree,
  resolveLink,
} from './worktreeFiles';

type DocsChannels =
  | 'docs:list'
  | 'docs:session'
  | 'docs:read'
  | 'docs:asset'
  | 'docs:resolve'
  | 'docs:openInEditor'
  | 'docs:reveal'
  | 'docs:watch'
  | 'html:open'
  | 'html:openExternal'
  | 'links:open';

const Position = z.number().int().min(1).optional();

export type DocsDeps = {
  taskById: (id: string) => Task;
  git: GitClient;
  /** Opens a file of the workspace at a line in the developer's editor (EditorService). */
  openFile: (
    ws: WorkspaceView,
    absFile: string,
    line?: number,
    col?: number,
  ) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  /** Opens a file with its default app; resolves to an error message, empty on success (shell.openPath). */
  openPath: (absPath: string) => Promise<string>;
  /** A `shellie-view:` URL serving a real HTML file and its folder (HtmlViews.grant). */
  grantView: (realFile: string) => string;
  revealFile: (absPath: string) => void;
  watcher: DocsWatcher;
  /** The task's session docs; also the whitelist for files outside its worktrees. */
  session: SessionDocs;
  event: (name: string, props?: TelemetryProps) => void;
};

/** Web links clicked in a terminal or a document: http(s) only, no credentials in the URL. */
export function allowedLink(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

const OUTSIDE = 'Outside the worktree';
const isOutside = (e: unknown) => e instanceof Error && e.message === OUTSIDE;

/** `/x` or `C:\x` / `C:/x`; not a UNC or `//host` path, so hovering a printed path never reaches the network. */
const isLocalAbsolute = (p: string) =>
  /^[A-Za-z]:[\\/]/.test(p) || (p.startsWith('/') && !p.startsWith('//'));

/** The real path of an existing `.html`/`.htm` regular file at an absolute local path, or null. */
export async function outsideHtml(p: string): Promise<string | null> {
  if (!HTML.test(p) || p.includes('\0') || !isLocalAbsolute(p)) return null;
  try {
    const real = await fs.realpath(p);
    if (!HTML.test(real)) return null;
    return (await fs.stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function createDocsHandlers(d: DocsDeps): Pick<Handlers, DocsChannels> {
  /** The task and workspace a docs target names; a plain task id is the active home. */
  const resolveTarget = (target: string) => {
    const { taskId, workspaceId } = parseDocsTarget(target);
    const t = d.taskById(taskId);
    if (t.status !== 'ready')
      throw new Error(`Cannot read docs of a task that is ${t.status}`);
    return { t, ws: workspaceById(t, workspaceId), workspaceId };
  };
  const workspace = (target: string) =>
    requireWorktree(resolveTarget(target).ws);
  const worktree = (target: string): string => workspace(target).worktreePath;
  /**
   * Runs `inside` on the target's worktree; a path outside it is allowed only when it is one of the task's
   * session docs (`session` gets that doc's real path). Anything else keeps the worktree's error.
   */
  const insideOrSession = async <T>(
    target: string,
    p: string,
    inside: (worktree: string) => Promise<T>,
    session: (real: string) => Promise<T>,
    find: (t: Task, p: string) => Promise<string | null> = async (t, q) =>
      (await d.session.find(t, q))?.real ?? null,
  ): Promise<T> => {
    const { t } = resolveTarget(target);
    try {
      return await inside(worktree(target));
    } catch (e) {
      if (!isOutside(e)) throw e;
      const real = await find(t, p);
      if (!real) throw e;
      return session(real);
    }
  };
  /** The real path of an HTML file: inside the target's worktree, or an absolute path to one anywhere else. */
  const htmlFile = async (target: string, p: string): Promise<string> => {
    if (typeof p !== 'string' || !HTML.test(p))
      throw new Error('Not an HTML file');
    let real: string;
    try {
      real = await resolveInWorktree(worktree(target), p);
    } catch (e) {
      if (!isOutside(e)) throw e;
      const outside = await outsideHtml(p);
      if (!outside) throw new Error(isLocalAbsolute(p) ? 'Not found' : OUTSIDE);
      real = outside;
    }
    if (!HTML.test(real)) throw new Error('Not an HTML file');
    return real;
  };
  return {
    'docs:list': async (target) => {
      const ws = workspace(target);
      return { files: await listDocs(d.git, ws.worktreePath, ws.baseSha) };
    },
    'docs:session': async (target) => {
      const { t } = resolveTarget(target);
      return { files: (await d.session.list(t)).map(toWire) };
    },
    'docs:read': async (target, p) =>
      insideOrSession(target, p, (w) => readDoc(w, p), readText),
    'docs:asset': async (target, p) =>
      insideOrSession(
        target,
        p,
        (w) => readAsset(w, p),
        readImage,
        (t, q) => d.session.assetPath(t, q),
      ),
    'docs:resolve': async (target, p) => {
      const { t, ws, workspaceId } = resolveTarget(target);
      if (workspaceId !== undefined) {
        if (!existsSync(ws.worktreePath)) return null;
        const r = await resolveLink(ws.worktreePath, p);
        return r && { ...r, workspaceId };
      }
      // A plain task id: the active home first, then the other active workspaces.
      const home = activeHome(t);
      const order = [home, ...activeWorkspaces(t).filter((w) => w !== home)];
      for (const w of order) {
        if (!existsSync(w.worktreePath)) continue;
        const r = await resolveLink(w.worktreePath, p);
        if (r) return w === home ? r : { ...r, workspaceId: w.id };
      }
      // A session doc outside the worktrees: absolute, or relative to one of them.
      const candidates =
        path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)
          ? [p]
          : order.map((w) => path.resolve(w.worktreePath, p));
      for (const c of candidates) {
        const hit = await d.session.find(t, c);
        if (hit && hit.workspaceId === null)
          return { path: toSlash(hit.path), kind: 'md' as const };
      }
      // An HTML file anywhere else, printed with its absolute path (a report a command wrote): shown in a tab.
      if (await outsideHtml(p))
        return { path: toSlash(path.resolve(p)), kind: 'html' as const };
      return null;
    },
    'docs:openInEditor': async (target, p, line, col) => {
      const at = Position.parse(line);
      const column = Position.parse(col);
      const ws = workspace(target);
      const abs = await insideOrSession(
        target,
        p,
        (w) => resolveInWorktree(w, p),
        async (real) => real,
      );
      await d.openFile(ws, abs, at, column);
    },
    'docs:reveal': async (target, p) => {
      d.revealFile(
        await insideOrSession(
          target,
          p,
          (w) => resolveInWorktree(w, p),
          async (real) => real,
        ),
      );
    },
    'docs:watch': async (target, on) => {
      if (!on) {
        d.watcher.stop(target);
        return { live: false };
      }
      const { taskId, workspaceId } = parseDocsTarget(target);
      const ws = watchableWorkspace(d.taskById(taskId), workspaceId);
      if (!ws) return { live: false };
      return { live: d.watcher.start(target, ws.worktreePath) };
    },
    'html:open': async (target, p) => {
      const real = await htmlFile(target, p);
      return { url: d.grantView(real), name: path.basename(real) };
    },
    'html:openExternal': async (target, p) => {
      const error = await d.openPath(await htmlFile(target, p));
      if (error) throw new Error(`Could not open the file: ${error}`);
    },
    'links:open': async (url) => {
      if (!allowedLink(url)) throw new Error(`Opening ${url} is not allowed`);
      await d.openExternal(url);
    },
  };
}
