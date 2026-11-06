// src/main/review/ReviewService.ts
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  type FileContent,
  type NewReviewComment,
  type ReviewFile,
  type ReviewFileRef,
  type ReviewFiles,
  type ReviewRepo,
  type ReviewScope,
  type ReviewState,
  type ReviewSummary,
  commentReadPath,
  viewedKey,
} from '../../shared/review';
import { anchorComment, captureAnchor } from '../../shared/reviewAnchor';
import type { Environment } from '../../shared/secrets';
import type { Task } from '../../shared/types';
import { activeWorkspaces, type WorkspaceView } from '../../shared/workspaces';
import { GitError, type GitClient } from '../services/GitClient';
import { requireWorktree } from '../workspaces/existing';
import type { ReviewStore } from './ReviewStore';
import {
  assertRelPath,
  countFiles,
  countUncommitted,
  listCommits,
  listFiles,
  rangeFor,
  readContent,
  readSide,
} from './reviewGit';
import { errorMessage } from '../../shared/errors';
import type { LeakMatcher } from '../secrets/LeakMatcher';
import { pathsWithLeaks } from '../secrets/leakScan';
import { graverEnvironment } from '../secrets/telemetry';

export type ReviewServiceDeps = {
  git: GitClient;
  store: ReviewStore;
  repoName: (repoId: string) => string;
  /** The repo's `review.collapse` globs, read from the worktree's `.shellie.yml`. */
  collapseOf: (worktree: string) => Promise<string[]>;
  /** Every stored value of the task's repos, to flag files whose added lines hold one; absent flags nothing. */
  leakMatcher?: (task: Task) => LeakMatcher;
  /** Telemetry: the Changes of a task hold stored values; the gravest environment among them. */
  onLeak?: (task: Task, env: Environment) => void;
  now?: () => Date;
  newId?: () => string;
};

const message = (e: unknown): string =>
  e instanceof GitError ? e.stderr.trim() || e.message.trim() : errorMessage(e);

export class ReviewService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly d: ReviewServiceDeps) {
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? randomUUID;
  }

  private workspaces(task: Task): WorkspaceView[] {
    if (task.status !== 'ready')
      throw new Error(`The task is not ready (${task.status})`);
    return activeWorkspaces(task);
  }

  private workspace(task: Task, id: string): WorkspaceView {
    const ws = this.workspaces(task).find((w) => w.id === id);
    if (!ws) throw new Error(`Unknown workspace ${id}`);
    return requireWorktree(ws);
  }

  private base(ws: WorkspaceView): Promise<string | null> {
    return this.d.git.resolveBase(ws.worktreePath, ws);
  }

  async files(task: Task, scope: ReviewScope): Promise<ReviewFiles> {
    const all = this.workspaces(task);
    const shown =
      scope.kind === 'commits'
        ? all.filter((w) => w.id === scope.workspaceId)
        : all;
    const repos = await Promise.all(
      shown.map(async (ws): Promise<ReviewRepo> => {
        const repo: ReviewRepo = {
          workspaceId: ws.id,
          name: this.d.repoName(ws.repoId),
          base: null,
          commits: [],
          files: [],
          uncommitted: 0,
          collapse: [],
        };
        if (!existsSync(ws.worktreePath))
          return { ...repo, error: 'The worktree is missing' };
        try {
          const wt = ws.worktreePath;
          const base = await this.base(ws);
          const files = rangeFor(this.d.git, wt, scope, base).then((range) =>
            listFiles(this.d.git, wt, range).then((list) =>
              this.flagSecrets(task, wt, range, list),
            ),
          );
          // Awaited below, after the rest; this only keeps an early failure from going unhandled.
          files.catch(() => {});
          const [commits, uncommitted, collapse] = await Promise.all([
            listCommits(this.d.git, wt, base),
            countUncommitted(this.d.git, wt),
            this.d.collapseOf(wt).catch(() => []),
          ]);
          Object.assign(repo, { base, commits, uncommitted, collapse });
          repo.files = await files;
          return repo;
        } catch (e) {
          return { ...repo, error: message(e) };
        }
      }),
    );
    return { repos };
  }

  /** The number of files in All changes across the task's repos; a repo that fails counts none. */
  async count(task: Task): Promise<number> {
    const counts = await Promise.all(
      this.workspaces(task).map(async (ws) => {
        if (!existsSync(ws.worktreePath)) return 0;
        try {
          const wt = ws.worktreePath;
          const range = await rangeFor(
            this.d.git,
            wt,
            { kind: 'all' },
            await this.base(ws),
          );
          return await countFiles(this.d.git, wt, range);
        } catch {
          return 0;
        }
      }),
    );
    return counts.reduce((a, b) => a + b, 0);
  }

  /** Marks the files whose added lines hold a stored value. A failed look flags nothing, as before leak watch. */
  private async flagSecrets(
    task: Task,
    wt: string,
    range: { from: string; to: string | null },
    list: ReviewFile[],
  ): Promise<ReviewFile[]> {
    const matcher = this.d.leakMatcher?.(task);
    if (!matcher || matcher.empty || list.length === 0) return list;
    const refs = range.to === null ? [range.from] : [range.from, range.to];
    try {
      const hits = await pathsWithLeaks(
        this.d.git,
        wt,
        refs,
        matcher,
        // Untracked files are not in the diff: against the working tree, an added file is read whole.
        range.to === null
          ? list.filter((f) => f.status === 'A').map((f) => f.path)
          : [],
      );
      let gravest: Environment | null = null;
      for (const env of hits.values())
        gravest = graverEnvironment(gravest, env);
      if (gravest !== null) this.d.onLeak?.(task, gravest);
      return list.map((f) => (hits.has(f.path) ? { ...f, secret: true } : f));
    } catch {
      console.warn('[secrets] could not check the changes for stored values');
      return list;
    }
  }

  async file(
    task: Task,
    workspaceId: string,
    file: ReviewFileRef,
    scope: ReviewScope,
  ): Promise<FileContent> {
    assertRelPath(file.path);
    if (file.oldPath) assertRelPath(file.oldPath);
    const ws = this.workspace(task, workspaceId);
    const range = await rangeFor(
      this.d.git,
      ws.worktreePath,
      scope,
      await this.base(ws),
    );
    return readContent(this.d.git, ws.worktreePath, range, file);
  }

  /**
   * Throws away what the scope shows for one file: Uncommitted puts it back as HEAD has it, All changes as
   * the base has it (a new file is deleted). Only a file the scope lists right now; never a commit scope.
   */
  async discard(
    task: Task,
    workspaceId: string,
    filePath: string,
    scope: ReviewScope,
  ): Promise<void> {
    assertRelPath(filePath);
    if (scope.kind === 'commits')
      throw new Error('Changes in a single commit cannot be discarded here');
    const ws = this.workspace(task, workspaceId);
    const wt = ws.worktreePath;
    const range = await rangeFor(this.d.git, wt, scope, await this.base(ws));
    const file = (await listFiles(this.d.git, wt, range)).find(
      (f) => f.path === filePath,
    );
    if (!file) throw new Error(`${filePath} is not in this list any more`);
    await this.d.git.discardPaths(
      wt,
      range.from,
      file.oldPath ? [file.oldPath, file.path] : [file.path],
    );
  }

  /** The state with every unresolved comment located again in the current files; saved only when one moved. */
  async state(task: Task): Promise<ReviewState> {
    const cur = await this.d.store.get(task.id);
    const active = new Map(activeWorkspaces(task).map((w) => [w.id, w]));
    const bases = new Map<string, Promise<string | null>>();
    const baseOf = (ws: WorkspaceView) => {
      let b = bases.get(ws.id);
      if (!b) {
        b = this.base(ws);
        bases.set(ws.id, b);
      }
      return b;
    };
    const texts = new Map<string, Promise<string | null>>();
    const textOf = (ws: WorkspaceView, side: 'before' | 'after', p: string) => {
      const key = `${ws.id}\0${side}\0${p}`;
      let t = texts.get(key);
      if (!t) {
        t = (async () => {
          if (!existsSync(ws.worktreePath)) return null;
          const ref = side === 'after' ? null : await baseOf(ws);
          if (side === 'before' && !ref) return null;
          return readSide(this.d.git, ws.worktreePath, ref, p).catch(
            () => null,
          );
        })();
        texts.set(key, t);
      }
      return t;
    };
    type Change = { at: { startLine: number; endLine: number } | null };
    const changes = new Map<string, Change>();
    const open = cur.comments.filter((c) => c.status !== 'resolved');
    // Settled, then walked in order: the first comment's failure is the one thrown, as when read one by one.
    const read = await Promise.allSettled(
      open.map((c) => {
        const ws = active.get(c.workspaceId);
        return ws ? textOf(ws, c.side, commentReadPath(c)) : null;
      }),
    );
    open.forEach((c, i) => {
      const r = read[i];
      if (r.status === 'rejected') throw r.reason;
      const at = r.value === null ? null : anchorComment(c, r.value);
      const revived = at && c.status === 'outdated';
      const moved =
        at && (at.startLine !== c.startLine || at.endLine !== c.endLine);
      if (!at ? c.status !== 'outdated' : revived || moved)
        changes.set(c.id, { at });
    });
    if (changes.size === 0) return cur;
    return this.d.store.update(task.id, (s) => {
      for (const c of s.comments) {
        const ch = changes.get(c.id);
        // A resolve that landed while the files were read wins.
        if (!ch || c.status === 'resolved') continue;
        if (!ch.at) c.status = 'outdated';
        else {
          c.startLine = ch.at.startLine;
          c.endLine = ch.at.endLine;
          if (c.status === 'outdated') c.status = c.sentAt ? 'sent' : 'open';
        }
      }
    });
  }

  setViewed(
    task: Task,
    key: string,
    hash: string | null,
  ): Promise<ReviewState> {
    if (key.length > 4096) throw new Error('Bad key');
    return this.d.store.update(task.id, (s) => {
      if (hash === null) delete s.viewed[key];
      else s.viewed[key] = hash;
    });
  }

  async addComment(task: Task, input: NewReviewComment): Promise<ReviewState> {
    assertRelPath(input.path);
    if (input.oldPath) assertRelPath(input.oldPath);
    const ws = this.workspace(task, input.workspaceId);
    const ref = input.side === 'after' ? null : await this.base(ws);
    if (input.side === 'before' && !ref)
      throw new Error('No base for this task');
    const text = await readSide(
      this.d.git,
      ws.worktreePath,
      ref,
      commentReadPath(input),
    );
    if (text === null) throw new Error('The file is not there any more');
    const at = captureAnchor(text, input.startLine, input.endLine);
    return this.d.store.update(task.id, (s) => {
      s.comments.push({
        id: this.newId(),
        workspaceId: input.workspaceId,
        path: input.path,
        ...(input.oldPath ? { oldPath: input.oldPath } : {}),
        side: input.side,
        text: input.text,
        ...at,
        status: 'open',
        createdAt: this.now().toISOString(),
        sentAt: null,
        resolvedAt: null,
      });
    });
  }

  updateComment(
    task: Task,
    id: string,
    patch: { text?: string; status?: 'open' | 'resolved' },
  ): Promise<ReviewState> {
    return this.d.store.update(task.id, (s) => {
      const c = s.comments.find((x) => x.id === id);
      if (!c) throw new Error('That comment is gone');
      if (patch.text !== undefined) c.text = patch.text;
      if (patch.status === 'resolved') {
        c.status = 'resolved';
        c.resolvedAt = this.now().toISOString();
      } else if (patch.status === 'open') {
        c.status = 'open';
        c.resolvedAt = null;
      }
    });
  }

  deleteComment(task: Task, id: string): Promise<ReviewState> {
    return this.d.store.update(task.id, (s) => {
      s.comments = s.comments.filter((c) => c.id !== id);
    });
  }

  markSent(task: Task, ids: string[]): Promise<ReviewState> {
    const want = new Set(ids);
    const at = this.now().toISOString();
    return this.d.store.update(task.id, (s) => {
      for (const c of s.comments)
        if (want.has(c.id) && c.status === 'open') {
          c.status = 'sent';
          c.sentAt = at;
        }
    });
  }

  async summary(task: Task): Promise<ReviewSummary> {
    const [{ repos }, state] = await Promise.all([
      this.files(task, { kind: 'all' }),
      this.state(task),
    ]);
    const files = repos.flatMap((r) =>
      r.files.map((f) => ({
        key: viewedKey(r.workspaceId, f.path),
        hash: f.hash,
      })),
    );
    return {
      files: files.length,
      notViewed: files.filter((f) => state.viewed[f.key] !== f.hash).length,
      unresolved: state.comments.filter((c) => c.status !== 'resolved').length,
    };
  }
}
