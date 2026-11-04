import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Connection, Task, Workspace } from '../../shared/types';
import { hasNoRepo, HOME_ID } from '../../shared/workspaces';
import { isInside, samePath } from '../paths';
import { matchConnection } from '../services/azureRepos';
import type { GitClient } from '../services/GitClient';
import type { RepoRegistry } from '../services/RepoRegistry';
import type { TaskStore } from '../services/TaskStore';
import { joinVerdict } from './join';
import {
  resolveCandidate,
  scanBranch,
  siblingRepos,
  type Candidate,
} from './resolve';
import { SessionLogReader, writeHitsFromLines } from './sessionLog';

export type WorkspaceDetectorDeps = {
  store: TaskStore;
  git: GitClient;
  repos: RepoRegistry;
  connections: () => Connection[];
  /** Claude Code's projects folder (`claudeProjectsDir()`). */
  projectsDir: () => string;
  reader?: SessionLogReader;
  /** A quiet info notice in the notice corner. */
  notice: (message: string) => void;
  /** Telemetry; no paths or repo names. */
  event: (name: string, props?: Record<string, string>) => void;
};

type Source = 'log' | 'branch' | 'manual';

/** Finds other repos' worktrees a task worked in (Claude's session logs, the task branch) and joins them. */
export class WorkspaceDetector {
  private readonly reader: SessionLogReader;
  private readonly scans = new Map<string, Promise<{ added: Workspace[] }>>();

  constructor(private readonly d: WorkspaceDetectorDeps) {
    this.reader = d.reader ?? new SessionLogReader();
  }

  /** Reads new session log lines and scans for the task branch, then joins what the rules allow. */
  scan(taskId: string): Promise<{ added: Workspace[] }> {
    const running = this.scans.get(taskId);
    if (running) return running;
    const run = this.runScan(taskId).finally(() => this.scans.delete(taskId));
    this.scans.set(taskId, run);
    return run;
  }

  /** Joins the worktree containing `folder` by hand; a path removed before may come back this way. */
  async add(taskId: string, folder: string): Promise<Workspace> {
    const task = this.task(taskId);
    if (task.status !== 'ready')
      throw new Error(`Cannot add a worktree to a task that is ${task.status}`);
    if (hasNoRepo(task))
      throw new Error('A task without a repo has no worktrees to add');
    const c = await resolveCandidate(this.d.git, folder);
    if (!c) throw new Error(`${folder} is not in a git repository`);
    const verdict = joinVerdict(
      { ...task, detachedPaths: [] },
      this.d.store.state.tasks,
      c,
    );
    const name = this.repoName(c.repoPath);
    if (verdict === 'main-checkout')
      throw new Error(`${name} is the main checkout; pick a worktree`);
    if (verdict === 'home' || verdict === 'already')
      throw new Error(`${name} is already in this task`);
    if (verdict === 'other-task')
      throw new Error(`${name} belongs to another open task`);
    const added = await this.join(taskId, c, 'manual');
    if (!added) throw new Error(`${name} could not be added to this task`);
    return added;
  }

  /** Drops an extra workspace from the task and remembers its path; the worktree and branch stay on disk. */
  async remove(taskId: string, workspaceId: string): Promise<void> {
    if (workspaceId === HOME_ID)
      throw new Error(
        'The home workspace cannot be removed while the task is open',
      );
    const task = this.task(taskId);
    if (!task.extraWorkspaces.some((w) => w.id === workspaceId))
      throw new Error(`Unknown workspace ${workspaceId}`);
    await this.d.store.update((s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      const w = t?.extraWorkspaces.find((x) => x.id === workspaceId);
      if (!t || !w) return;
      t.extraWorkspaces = t.extraWorkspaces.filter((x) => x !== w);
      if (!t.detachedPaths.some((p) => samePath(p, w.worktreePath)))
        t.detachedPaths.push(w.worktreePath);
    });
    this.d.event('workspace.removed');
  }

  private task(taskId: string): Task {
    const t = this.d.store.state.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error(`Unknown task ${taskId}`);
    return t;
  }

  private repoName(repoPath: string): string {
    return (
      this.d.repos.list().find((r) => samePath(r.path, repoPath))?.name ??
      path.basename(repoPath)
    );
  }

  private async runScan(taskId: string): Promise<{ added: Workspace[] }> {
    const task = this.task(taskId);
    // Finish, setup and Reopen work from the task's workspace list; it must not change under them.
    if (task.status !== 'ready') return { added: [] };
    // A task without a repo stays without one: its scratch folder has no git (#225).
    if (hasNoRepo(task)) return { added: [] };
    const found: { c: Candidate; source: Source }[] = [];
    const seen = (p: string) =>
      found.some((f) => samePath(f.c.worktreePath, p));

    for (const c of await this.fromLogs(task))
      if (!seen(c.worktreePath)) found.push({ c, source: 'log' });
    for (const c of await this.fromBranch(task))
      if (!seen(c.worktreePath)) found.push({ c, source: 'branch' });

    const added: Workspace[] = [];
    for (const { c, source } of found) {
      // One odd candidate (a bare repo, a git error) must not cost the others their turn.
      try {
        const verdict = joinVerdict(
          this.task(taskId),
          this.d.store.state.tasks,
          c,
        );
        if (verdict === 'main-checkout') await this.noteMainCheckout(taskId, c);
        else if (verdict === 'join') {
          const w = await this.join(taskId, c, source);
          if (w) added.push(w);
        }
      } catch (e) {
        console.warn('[workspaces] skipped a candidate', e);
      }
    }
    return { added };
  }

  /** Worktrees the task's Claude tabs (open and closed) wrote in, outside its home worktree. */
  private async fromLogs(task: Task): Promise<Candidate[]> {
    const ids = new Set(
      [...task.terminals, ...task.closedTerminals]
        .filter((t) => t.kind === 'claude' && t.sessionId)
        .map((t) => t.sessionId as string),
    );
    const paths: string[] = [];
    const folders = ids.size > 0 ? await this.projectFolders() : [];
    for (const id of ids)
      for (const file of await sessionFiles(folders, id))
        for (const hit of writeHitsFromLines(await this.reader.readNew(file)))
          if (
            !isInside(task.worktreePath, hit.path) &&
            !paths.some((p) => samePath(p, hit.path))
          )
            paths.push(hit.path);
    const out: Candidate[] = [];
    for (const p of paths) {
      try {
        const c = await resolveCandidate(this.d.git, p);
        if (c && !out.some((o) => samePath(o.worktreePath, c.worktreePath)))
          out.push(c);
      } catch (e) {
        console.warn('[workspaces] skipped a path from a session log', e);
      }
    }
    return out;
  }

  /** The folders in projectsDir, as full paths; none when it cannot be read. */
  private async projectFolders(): Promise<string[]> {
    const dir = this.d.projectsDir();
    try {
      return (await fs.readdir(dir)).map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  /** Worktrees on the task branch in registered repos and their sibling repos. */
  private async fromBranch(task: Task): Promise<Candidate[]> {
    const registered = this.d.repos.list().map((r) => r.path);
    const siblings = await siblingRepos(registered);
    return scanBranch(this.d.git, [...registered, ...siblings], task.branch);
  }

  private async noteMainCheckout(taskId: string, c: Candidate): Promise<void> {
    const known = (t: Task) =>
      t.mainCheckoutEdits.some(
        (e) => samePath(e.repoPath, c.repoPath) && e.branch === c.branch,
      );
    if (known(this.task(taskId))) return;
    await this.d.store.update((s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (t && !known(t))
        t.mainCheckoutEdits.push({ repoPath: c.repoPath, branch: c.branch });
    });
  }

  /** Registers the repo when unknown and adds the workspace; null when the rules no longer allow it. */
  private async join(
    taskId: string,
    c: Candidate,
    source: Source,
  ): Promise<Workspace | null> {
    const branch = c.branch ?? (await this.d.git.currentBranch(c.worktreePath));
    if (!branch) return null; // detached HEAD: nothing to push or PR
    const remote = await this.d.git.remoteUrl(c.repoPath, 'origin');
    const repo = await this.d.repos.addDiscovered(
      c.repoPath,
      matchConnection(remote, this.d.connections())?.id ?? null,
    );
    const baseRef = await this.d.git.defaultBaseRef(c.worktreePath);
    const workspace: Workspace = {
      id: randomUUID(),
      repoId: repo.id,
      branch,
      worktreePath: c.worktreePath,
      baseRef,
      baseSha: await this.d.git.mergeBase(c.worktreePath, 'HEAD', baseRef),
      source: source === 'manual' ? 'manual' : 'detected',
      summary: null,
      pullRequest: null,
      reopen: null,
      dropped: false,
    };
    let joined = false;
    await this.d.store.update((s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      // Finish or setup may have started while git ran.
      if (!t || t.status !== 'ready') return;
      // Adding by hand overrides an earlier remove.
      const detachedPaths =
        source === 'manual'
          ? t.detachedPaths.filter((p) => !samePath(p, c.worktreePath))
          : t.detachedPaths;
      // Re-check against the latest state: another scan or add may have joined it meanwhile.
      if (joinVerdict({ ...t, detachedPaths }, s.tasks, c) !== 'join') return;
      t.detachedPaths = detachedPaths;
      t.extraWorkspaces.push(workspace);
      joined = true;
    });
    if (!joined) return null;
    this.d.notice(`Added ${repo.name} to this task`);
    this.d.event('workspace.joined', { source });
    return workspace;
  }
}

/** `<projectsDir>/<any folder>/<sessionId>.jsonl`; Claude's folder naming per cwd does not matter. */
async function sessionFiles(
  folders: string[],
  sessionId: string,
): Promise<string[]> {
  const files = folders.map((f) => path.join(f, `${sessionId}.jsonl`));
  const isFile = await Promise.all(
    files.map((file) =>
      fs.stat(file).then(
        (st) => st.isFile(),
        () => false, // not in this folder
      ),
    ),
  );
  return files.filter((_, i) => isFile[i]);
}
