import { errorMessage } from '../../shared/errors';
import type {
  DiscardedCleanup,
  PendingCleanup,
  Task,
} from '../../shared/types';
import { taskWorkspaces } from '../../shared/workspaces';
import { pathExists } from '../fsRetry';
import { sameFolder, samePath } from '../paths';
import { FOLDER_IN_USE, GitError, type GitClient } from './GitClient';

/**
 * Removing a finished task's worktree without failing Finish (#115). On Windows a process that outlives the
 * task's terminals (a dev server's child, a dotnet build server, an editor, antivirus) often still holds a
 * file in the folder, so the removal fails every time for a while and then works. Finish keeps what is left
 * on the task (`pendingCleanup`), the task is done, and WorktreeCleanup retries it in the background.
 */

export type CleanupGit = Pick<
  GitClient,
  | 'worktreeRemove'
  | 'worktreePrune'
  | 'deleteBranch'
  | 'branchExists'
  | 'worktreeList'
>;

/** Git's refusal to delete a branch a registered worktree still has checked out. */
const BRANCH_IN_USE = /used by worktree|checked out at/i;

/** After this long the retries go on, but the user hears about it once. */
export const GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** How often main retries what is left (and once shortly after launch). */
export const RETRY_EVERY_MS = 3 * 60 * 1000;

/** A branch some unlisted or vanished worktree holds is not retried past this many attempts (#400). */
export const BRANCH_IN_USE_ATTEMPTS = 10;

/**
 * A short code for telemetry and the Done page: the fs code (EPERM, EBUSY...), else in-use, branch-in-use,
 * git or other.
 */
export function cleanupErrorCode(e: unknown): string {
  for (let x = e, depth = 0; x && depth < 5; depth++) {
    if (x instanceof GitError) {
      if (FOLDER_IN_USE.test(x.stderr)) return 'in-use';
      return BRANCH_IN_USE.test(x.stderr) ? 'branch-in-use' : 'git';
    }
    const code = (x as { code?: unknown }).code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code;
    x = (x as { cause?: unknown }).cause;
  }
  return 'other';
}

type Target = Pick<
  PendingCleanup,
  'workspaceId' | 'repoPath' | 'worktreePath' | 'branch'
>;

/**
 * Removes a worktree folder (forced), then its branch when `branch` is set. Never throws: what could not be
 * done comes back as a PendingCleanup to retry, null when everything is gone.
 */
export async function removeWorkspace(
  git: CleanupGit,
  t: Target,
  d: { exists?: (p: string) => Promise<boolean>; now: () => number },
): Promise<PendingCleanup | null> {
  const exists = d.exists ?? pathExists;
  const left = (e: unknown): PendingCleanup => ({
    ...t,
    since: new Date(d.now()).toISOString(),
    attempts: 1,
    error: errorMessage(e),
    code: cleanupErrorCode(e),
    notified: false,
  });
  if (await exists(t.worktreePath)) {
    try {
      await git.worktreeRemove(t.repoPath, t.worktreePath, true);
    } catch (e) {
      // The branch waits too: git will not delete a branch a registered worktree has checked out.
      if (await exists(t.worktreePath)) return left(e);
    }
  }
  if (t.branch === null) return null;
  const branch = t.branch;
  try {
    // A deleted folder leaves a stale registration that blocks branch deletion.
    await git.worktreePrune(t.repoPath);
    if (await git.branchExists(t.repoPath, branch))
      await git.deleteBranch(t.repoPath, branch);
    return null;
  } catch (e) {
    if (!(e instanceof GitError) || !BRANCH_IN_USE.test(e.stderr))
      return left(e);
    // Prune keeps a registration whose folder is still there (half-removed on Windows) or that git lists
    // under another path form, and that registration still holds the branch (#379).
    let listFailed = false;
    const list = await git.worktreeList(t.repoPath).catch(() => {
      listFailed = true;
      return [];
    });
    const holder = list.find((w) => w.branch === branch);
    const own = !!holder && sameFolder(holder.path, t.worktreePath);
    const holderExists = !!holder && (await exists(holder.path));
    // No paths: tells a path-form mismatch from a really different worktree (#400).
    const loose = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    console.warn(
      `[cleanup] branch held: ${JSON.stringify({
        holderListed: !!holder,
        listFailed,
        own,
        sameAfterCase: !!holder && loose(holder.path) === loose(t.worktreePath),
        holderExists,
        holderIsMain: !!holder && holder === list[0],
        taskExists: await exists(t.worktreePath),
      })}`,
    );
    // Any other worktree may be a reopened or live task: never touch it. One that is there for sure stays,
    // so retrying is pointless.
    if (!holder || !own)
      return holder && holderExists ? { ...left(e), final: true } : left(e);
    try {
      await git.worktreeRemove(t.repoPath, holder.path, true);
      await git.worktreePrune(t.repoPath);
      await git.deleteBranch(t.repoPath, branch);
      return null;
    } catch (again) {
      return left(again);
    }
  }
}

export type WorktreeCleanupDeps = {
  git: CleanupGit;
  tasks: () => Task[];
  /** Takes the task for the retry; false when it is busy (Finish, Reopen) so it is skipped this time. */
  claim: (taskId: string) => boolean;
  release: (taskId: string) => void;
  /** One store write on the task, then the windows hear of it. */
  mutate: (taskId: string, change: (t: Task) => void) => Promise<void>;
  notice: (message: string) => void;
  event: (
    name: string,
    props?: Record<string, string>,
    measurements?: Record<string, number>,
  ) => void;
  now?: () => number;
  exists?: (p: string) => Promise<boolean>;
  /** Leftovers of discarded tasks (#124): the task is gone, so they are kept in a list of their own. */
  discarded?: {
    list: () => DiscardedCleanup[];
    /** One store write of the list. */
    mutate: (
      change: (list: DiscardedCleanup[]) => DiscardedCleanup[],
    ) => Promise<void>;
  };
};

/** Given up on and told the user: the background no longer retries it. */
const settled = (p: PendingCleanup) => p.final === true && p.notified;

const key = (p: DiscardedCleanup) => `${p.taskId}\u0000${p.workspaceId}`;

export class WorktreeCleanup {
  private readonly now: () => number;
  private discardBusy = false;

  constructor(private readonly d: WorktreeCleanupDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Retries every done task's leftovers, one task at a time. */
  async retryAll(): Promise<void> {
    const ids = this.d
      .tasks()
      .filter(
        (t) => t.status === 'done' && t.pendingCleanup.some((p) => !settled(p)),
      )
      .map((t) => t.id);
    for (const id of ids)
      await this.retryTask(id, false).catch(() => undefined);
    await this.retryDiscarded().catch(() => undefined);
  }

  /**
   * Retries what discarded tasks left (#124). A folder a task uses again (a new task at the same path) is never
   * touched: its entry is dropped.
   */
  async retryDiscarded(): Promise<void> {
    const d = this.d.discarded;
    if (!d || this.discardBusy) return;
    const items = d.list();
    if (items.length === 0) return;
    this.discardBusy = true;
    try {
      const inUse = (p: DiscardedCleanup) =>
        this.d
          .tasks()
          .some(
            (t) =>
              t.status !== 'done' &&
              taskWorkspaces(t).some((w) =>
                samePath(w.worktreePath, p.worktreePath),
              ),
          );
      const after = await this.retryItems(
        items.filter((p) => !inUse(p)),
        'a discarded task',
        false,
      );
      const tried = new Set(items.map(key));
      await d.mutate((list) => [
        ...after,
        ...list.filter((p) => !tried.has(key(p))),
      ]);
    } finally {
      this.discardBusy = false;
    }
  }

  /**
   * Retries one task's leftovers now. True when nothing is left. `all` (Retry now on the Done page) also tries
   * the ones the background gave up on.
   */
  async retryTask(taskId: string, all = true): Promise<boolean> {
    const task = this.d.tasks().find((t) => t.id === taskId);
    if (!task) return true;
    // A reopened task makes its worktree again at the same path: never touch it then.
    if (task.status !== 'done') return task.pendingCleanup.length === 0;
    if (task.pendingCleanup.length === 0) return true;
    if (!this.d.claim(taskId)) return false;
    try {
      const after = await this.retryItems(
        task.pendingCleanup,
        'a finished task',
        all,
      );
      await this.d.mutate(taskId, (t) => {
        t.pendingCleanup = after;
      });
      return after.length === 0;
    } finally {
      this.d.release(taskId);
    }
  }

  /** One more try at each leftover; returns what is still left, with its attempts and last error. */
  private async retryItems<T extends PendingCleanup>(
    items: T[],
    leftBy: string,
    all: boolean,
  ): Promise<T[]> {
    const after: T[] = [];
    for (const p of items) {
      if (!all && settled(p)) {
        after.push(p);
        continue;
      }
      const left = await removeWorkspace(this.d.git, p, {
        exists: this.d.exists,
        now: this.now,
      });
      if (!left) {
        this.d.event(
          'cleanup.done',
          { code: p.code },
          {
            attempts: p.attempts + 1,
            minutes: Math.round((this.now() - Date.parse(p.since)) / 60_000),
          },
        );
        continue;
      }
      const next: T = {
        ...p,
        attempts: p.attempts + 1,
        error: left.error,
        code: left.code,
      };
      const capped =
        next.code === 'branch-in-use' &&
        next.attempts >= BRANCH_IN_USE_ATTEMPTS;
      if (left.final || capped) next.final = true;
      else delete next.final;
      // Local log only: tells a held folder (EBUSY, in-use) from other failures when the counts look odd.
      console.warn(
        `[cleanup] attempt ${next.attempts} left ${p.worktreePath} (${next.code}): ${next.error}`,
      );
      // Finish may already have stored it final: the user hears of it on its first retry.
      if (next.final && !p.notified) {
        next.notified = true;
        this.d.event(
          'cleanup.gaveUp',
          {
            code: next.code,
            reason: left.final ? 'other-worktree' : 'attempts',
          },
          { attempts: next.attempts },
        );
        this.d.notice(
          `Shellie could not delete the branch ${p.branch}, left by ${leftBy}: ${next.error}. ` +
            'Another worktree still has it checked out, so Shellie stopped trying. Delete the branch yourself ' +
            'once that worktree is done with it, or press Retry now on the task.',
        );
      } else if (
        !next.final &&
        !p.notified &&
        this.now() - Date.parse(p.since) >= GIVE_UP_MS
      ) {
        next.notified = true;
        this.d.event(
          'cleanup.gaveUp',
          { code: next.code },
          { attempts: next.attempts },
        );
        this.d.notice(
          `Shellie has tried for a day to delete ${p.worktreePath}, left by ${leftBy}: ${next.error}. ` +
            'A process still holds a file there: close what runs from that folder (a dev server, an editor, ' +
            'a dotnet build server: dotnet build-server shutdown), or delete the folder yourself. Shellie keeps trying.',
        );
      }
      after.push(next);
    }
    return after;
  }
}
