/**
 * The `dream:*` IPC handlers (spec sections 1, 5 and 8). The renderer is not trusted to switch dreaming on: `enabled`
 * becomes true only through `dream:switchOn`, with every step done and the owner's tick; `dream:save` never takes
 * `enabled`, `model` or `testedModel`, and a change that widens dreaming while it is on needs the tick again.
 *
 * Messages are fixed phrases: never a run's output, session text, a path or git's own errors.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isOpencodeModel } from '../../shared/brain';
import {
  canSwitchOn,
  DreamingSettingsSchema,
  widens,
  type DreamingSettings,
  type DreamProposal,
  type DreamResult,
  type DreamUsage,
  type DreamView,
} from '../../shared/dreams';
import type { Handlers } from '../../shared/ipc';
import type { AppSettings } from '../../shared/usage';
import { pathExists, removeTree } from '../fsRetry';
import { isInside } from '../paths';
import type { Platform } from '../platform/Platform';
import type { GitClient } from '../services/GitClient';
import { programMissing, type runWithInput } from '../services/prSummary';
import type { DreamStore } from './DreamStore';
import { authorConfig, removeDream, unattendedConfig } from './dreamGit';
import { sessionOf } from './dreamRun';
import { hasPrice } from './limit';
import { dreamArgs, dreamEnv, otherModels } from './opencodeDream';
import type { DreamScheduler } from './scheduler';

export const DREAM_TEST_TIMEOUT_MS = 2 * 60_000;
/** The test call's prompt: tiny and fixed. */
export const DREAM_TEST_PROMPT = 'Reply with the single word: ok';
/** How long the branch `dream:openAsTask` returned may be made into a task. */
const OPENED_MS = 10 * 60_000;
/** OpenCode's model list counts as known this long. */
const MODELS_MS = 10 * 60_000;

const OPEN_FAILED = 'The dream could not be opened as a task';

export type DreamChannel = Extract<keyof Handlers, `dream:${string}`>;
export type DreamHandlers = Pick<Handlers, DreamChannel>;

/** What `tasks:create` asks about a `fromDream` task. */
export type DreamTaskLink = {
  /** True when `dream:openAsTask` returned `branch` for this dream of this repo less than 10 minutes ago. */
  opened(dreamId: string, repoId: string, branch: string): boolean;
  /** The task was made: the pair is used up and the journal names the task. */
  taskCreated(dreamId: string, repoId: string, taskName: string): Promise<void>;
};

export type DreamApi = { handlers: DreamHandlers; taskLink: DreamTaskLink };

type Repo = { id: string; name: string; path: string };

export type DreamHandlerDeps = {
  settings: {
    get(): AppSettings;
    update(fn: (current: AppSettings) => AppSettings): Promise<AppSettings>;
  };
  store: DreamStore;
  /** Null until the scheduler started (the store is loaded then); only reads are answered before. */
  scheduler: () => Pick<
    DreamScheduler,
    'dreamNow' | 'stopDream' | 'status' | 'switchOn'
  > | null;
  repos: () => Repo[];
  git: Pick<
    GitClient,
    'run' | 'branchExists' | 'worktreeRemove' | 'worktreePrune' | 'deleteBranch'
  >;
  platform: Pick<Platform, 'opencodeCommand'>;
  /** The spawn helper the runner uses (main: the pty host's); it kills the process on its timeout. */
  run: typeof runWithInput;
  /** The models of every assistant message of a session and its child sessions. */
  sessionModels: (sessionId: string) => string[];
  /** OpenCode's model list; null when it is not known. */
  models: () => Promise<string[] | null>;
  /** Today's dream usage (`limitChecks(...).usage`). */
  usage: () => DreamUsage;
  /** Every dream's folder lies in it; nothing outside it is ever removed. */
  dreamsDir: string;
  /** Sends `dream:changed`. */
  broadcast: () => void;
  now?: () => number;
  /** Where the test call's empty folders are made; the system temp folder by default. */
  tmpDir?: string;
};

const flags = (config: string[]) => config.flatMap((c) => ['-c', c]);

/** The handlers when dreams are not wired (tests that do not care): every call fails, no task is from a dream. */
export function noDreams(): DreamApi {
  const no = async (): Promise<never> => {
    throw new Error('Dreams are not available');
  };
  return {
    handlers: {
      'dream:get': no,
      'dream:test': no,
      'dream:save': no,
      'dream:switchOn': no,
      'dream:switchOff': no,
      'dream:now': no,
      'dream:stop': no,
      'dream:drop': no,
      'dream:discard': no,
      'dream:openAsTask': no,
    },
    taskLink: { opened: () => false, taskCreated: async () => undefined },
  };
}

export function createDreamHandlers(d: DreamHandlerDeps): DreamApi {
  const now = d.now ?? Date.now;
  let models: { at: number; list: string[] } | null = null;
  let asking: Promise<string[] | null> | null = null;
  let testing = false;
  /** `<repoId>\0<dreamId>` → the branch `dream:openAsTask` returned, until a task is made from it or 10 minutes pass. */
  const opened = new Map<
    string,
    { branch: string; kept: number; dropped: number; until: number }
  >();
  const key = (repoId: string, dreamId: string) => `${repoId}\0${dreamId}`;
  // Drop, discard and open as task change the open result: one after another.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => undefined);
    return p;
  };

  /** OpenCode's models: kept 10 minutes; a failed ask is not kept. `fresh` asks again. */
  const modelList = (fresh = false): Promise<string[] | null> => {
    if (!fresh && models && now() - models.at < MODELS_MS)
      return Promise.resolve(models.list);
    asking ??= d
      .models()
      .catch(() => null)
      .then((list) => {
        if (list) models = { at: now(), list };
        return list;
      })
      .finally(() => {
        asking = null;
      });
    return asking;
  };

  /** The scheduler, for a call that writes the dream store: it is loaded once the scheduler started. */
  const started = () => {
    const s = d.scheduler();
    if (!s) throw new Error('Dreams are still starting');
    return s;
  };

  const saveDreaming = async (
    fn: (cur: DreamingSettings) => DreamingSettings,
  ): Promise<DreamingSettings> =>
    (await d.settings.update((cur) => ({ ...cur, dreaming: fn(cur.dreaming) })))
      .dreaming;

  const openResult = (repoId: string): DreamResult => {
    const r = d.store.repo(repoId).result;
    if (!r) throw new Error('This repo has no dream to review');
    return r;
  };

  /** The dream's folder (worktree, data, hooks), refused when it is not in the dreams folder. */
  const dreamDir = async (r: DreamResult): Promise<string> => {
    const dir = path.dirname(r.worktreePath);
    const real = await fs.realpath(d.dreamsDir).catch(() => d.dreamsDir);
    const inDreams = (p: string) =>
      p !== d.dreamsDir &&
      p !== real &&
      (isInside(d.dreamsDir, p) || isInside(real, p));
    if (!inDreams(dir) || !inDreams(r.dataDir))
      throw new Error('The dream is not in the dreams folder');
    return dir;
  };

  /** Removes what the result made: its folder, and with `branch` its branch. Throws a fixed phrase on a failure. */
  const removeResult = async (
    r: DreamResult,
    branch: boolean,
    message: string,
  ) => {
    const dir = await dreamDir(r);
    const repo = d.repos().find((x) => x.id === r.repoId);
    const failure = repo
      ? await removeDream(d.git, repo.path, {
          dir,
          worktree: r.worktreePath,
          branch: branch ? r.branch : null,
        })
      : await removeTree(dir).then(
          () => null,
          (e: unknown) => e,
        );
    // Inside the folder as the runner makes it; removed on its own should a result say otherwise.
    const data = failure
      ? null
      : await removeTree(r.dataDir).then(
          () => null,
          (e: unknown) => e,
        );
    if (failure || data) {
      console.error('[dreams] a dream could not be removed', failure ?? data);
      throw new Error(message);
    }
  };

  const discard = async (repoId: string, r: DreamResult) => {
    await removeResult(r, true, 'The dream could not be removed');
    await d.store.reject(repoId, r.proposals);
    await d.store.closeJournal(repoId, r.id, {
      as: 'discarded',
      kept: 0,
      dropped: r.proposals.length,
      taskName: null,
    });
    await d.store.setResult(repoId, null);
    d.broadcast();
  };

  /**
   * Whether the branch already is the base plus the kept proposals' changes, one commit each: nothing dropped, or an
   * earlier call rebuilt it and then failed to remove the worktree. Asked in the repo (read-only git, no hooks), so it
   * also answers once the worktree is gone. Any doubt is false.
   */
  const built = async (r: DreamResult, kept: DreamProposal[]) => {
    const repo = d.repos().find((x) => x.id === r.repoId);
    if (!repo) return false;
    const ref = `refs/heads/${r.branch}`;
    try {
      await d.git.run(repo.path, [
        'merge-base',
        '--is-ancestor',
        r.baseSha,
        ref,
      ]);
      const count = (
        await d.git.run(repo.path, [
          'rev-list',
          '--count',
          `${r.baseSha}..${ref}`,
        ])
      ).trim();
      if (Number(count) !== kept.length) return false;
      for (const p of kept) {
        // Nothing when the commit is on the branch itself, `-` when the branch holds one with the same change (patch
        // id), `+` when it holds none.
        const out = await d.git.run(repo.path, [
          'cherry',
          ref,
          p.commit,
          `${p.commit}^`,
        ]);
        if (out.trim().startsWith('+')) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  /**
   * The branch as the base plus the kept proposals' commits, in order, with hooks off. On a failure the branch is put
   * back where it was.
   */
  const rebuild = async (r: DreamResult, kept: DreamProposal[]) => {
    const wt = r.worktreePath;
    if (!(await pathExists(wt))) throw new Error(OPEN_FAILED);
    const hooks = path.join(path.dirname(wt), 'hooks');
    await fs.mkdir(hooks, { recursive: true });
    const base = unattendedConfig(hooks);
    const c = flags([...base, ...(await authorConfig(d.git, wt, base))]);
    let tip: string;
    try {
      tip = (await d.git.run(wt, [...c, 'rev-parse', 'HEAD'])).trim();
    } catch {
      throw new Error(OPEN_FAILED);
    }
    try {
      await d.git.run(wt, [...c, 'reset', '-q', '--hard', r.baseSha]);
      await d.git.run(wt, [...c, 'cherry-pick', ...kept.map((p) => p.commit)]);
    } catch {
      await d.git
        .run(wt, [...c, 'cherry-pick', '--abort'])
        .catch(() => undefined);
      await d.git
        .run(wt, [...c, 'reset', '-q', '--hard', tip])
        .catch((e: unknown) =>
          console.error('[dreams] the dream branch could not be put back', e),
        );
      throw new Error(OPEN_FAILED);
    }
  };

  /** One call with the model, as a dream makes it, in an empty folder; null when the model alone answered. */
  const testCall = async (model: string): Promise<string | null> => {
    const root = await fs.mkdtemp(
      path.join(d.tmpDir ?? os.tmpdir(), 'shellie-dream-test-'),
    );
    try {
      const worktree = path.join(root, 'wt');
      const dataDir = path.join(root, 'data');
      await fs.mkdir(worktree);
      await fs.mkdir(dataDir);
      const cwd = await fs.realpath(worktree);
      const cmd = d.platform.opencodeCommand(
        undefined,
        dreamArgs(model, 'test'),
      );
      const env = dreamEnv(cmd.env ?? {}, { model, worktree: cwd, dataDir });
      let stdout: string;
      try {
        stdout = await d.run(
          { ...cmd, env },
          {
            cwd,
            input: DREAM_TEST_PROMPT,
            timeoutMs: DREAM_TEST_TIMEOUT_MS,
            env,
          },
        );
      } catch (e) {
        if (programMissing(e)) return 'OpenCode was not found';
        if (/timed out/i.test((e as Error | null)?.message ?? ''))
          return 'The test timed out';
        return `${model} did not answer`;
      }
      let answered: string[];
      try {
        const session = sessionOf(stdout);
        answered = session ? d.sessionModels(session) : [];
      } catch {
        answered = [];
      }
      if (answered.length === 0) return `${model} did not answer`;
      if (otherModels(answered, model).length > 0)
        return 'Another model answered';
      return null;
    } finally {
      await removeTree(root).catch((e: unknown) =>
        console.error('[dreams] the test folder could not be removed', e),
      );
    }
  };

  const usageNow = (): DreamUsage => {
    try {
      return d.usage();
    } catch (e) {
      console.error('[dreams] today’s usage could not be read', e);
      return { day: '', tokens: 0, eur: null };
    }
  };

  const status = () => {
    try {
      return d.scheduler()?.status() ?? null;
    } catch (e) {
      console.error('[dreams] the scheduler status could not be read', e);
      return null;
    }
  };

  const handlers: DreamHandlers = {
    'dream:get': async (): Promise<DreamView> => {
      const settings = d.settings.get().dreaming;
      const st = status();
      const repos = await Promise.all(
        d.repos().map(async (r) => ({
          id: r.id,
          name: r.name,
          suggestedFolders: (await fs
            .stat(path.join(r.path, '.apm'))
            .then((x) => x.isDirectory())
            .catch(() => false))
            ? ['.apm']
            : [],
          newSessions: st?.newSessions[r.id] ?? 0,
          state: d.store.repo(r.id),
        })),
      );
      return {
        settings,
        models: await modelList(),
        euroLimitOffered: settings.model !== null && hasPrice(settings.model),
        usage: usageNow(),
        waiting: st?.wait ?? null,
        next: st?.next ?? null,
        running: st?.running ?? null,
        switchedOff: d.store.switchedOff(),
        repos,
        journal: d.store.journal(),
      };
    },

    'dream:test': async (model) => {
      if (testing) return { ok: false, message: 'A test is already running' };
      testing = true;
      try {
        const listed = async (fresh: boolean) =>
          (await modelList(fresh))?.includes(model) ?? false;
        if (
          typeof model !== 'string' ||
          !isOpencodeModel(model) ||
          !((await listed(false)) || (await listed(true)))
        )
          return {
            ok: false,
            message: `${String(model)} is not available in OpenCode`,
          };
        const failure = await testCall(model);
        if (failure) return { ok: false, message: failure };
        await saveDreaming((cur) => ({
          ...cur,
          model,
          testedModel: model,
          // A new model is confirmed again before it dreams.
          enabled: cur.model === model ? cur.enabled : false,
        }));
        d.broadcast();
        return { ok: true };
      } finally {
        testing = false;
      }
    },

    'dream:save': async (next, acknowledged) => {
      const parsed = DreamingSettingsSchema.safeParse(next);
      if (!parsed.success)
        throw new Error('These dream settings are not valid');
      const known = new Set(d.repos().map((r) => r.id));
      const saved = await saveDreaming((prev) => {
        const merged: DreamingSettings = {
          ...parsed.data,
          enabled: prev.enabled,
          model: prev.model,
          testedModel: prev.testedModel,
          repos: Object.fromEntries(
            Object.entries(parsed.data.repos).filter(([id]) => known.has(id)),
          ),
        };
        if (prev.enabled && widens(prev, merged) && acknowledged !== true)
          throw new Error('Confirm the change first');
        return merged;
      });
      d.broadcast();
      return saved;
    },

    'dream:switchOn': async (acknowledged) => {
      const reason = canSwitchOn(d.settings.get().dreaming);
      if (reason)
        throw new Error(`Dreaming cannot be switched on yet: ${reason}`);
      if (acknowledged !== true) throw new Error('Tick the box first');
      await started().switchOn(async () => {
        await saveDreaming((cur) => {
          // Checked again as the write runs: a save queued meanwhile may have changed the settings.
          const again = canSwitchOn(cur);
          if (again)
            throw new Error(`Dreaming cannot be switched on yet: ${again}`);
          return { ...cur, enabled: true };
        });
      });
      d.broadcast();
      return d.settings.get().dreaming;
    },

    'dream:switchOff': async () => {
      const saved = await saveDreaming((cur) => ({ ...cur, enabled: false }));
      // Switched off means no model calls: a dream that runs now stops too.
      d.scheduler()?.stopDream();
      d.broadcast();
      return saved;
    },

    // The scheduler decides, as for its own checks, and sends `dream:changed` when a dream starts or ends.
    'dream:now': (repoId) => started().dreamNow(repoId),

    'dream:stop': async () => {
      d.scheduler()?.stopDream();
    },

    'dream:drop': (repoId, proposalId, dropped) =>
      serial(async () => {
        started();
        if (!openResult(repoId).proposals.some((p) => p.id === proposalId))
          throw new Error('This dream has no such proposal');
        await d.store.setDropped(repoId, proposalId, dropped === true);
        d.broadcast();
      }),

    'dream:discard': (repoId) =>
      serial(async () => {
        started();
        await discard(repoId, openResult(repoId));
      }),

    'dream:openAsTask': (repoId) =>
      serial(async () => {
        started();
        const r = openResult(repoId);
        const kept = r.proposals.filter((p) => !p.dropped);
        const dropped = r.proposals.filter((p) => p.dropped);
        if (kept.length === 0) {
          await discard(repoId, r);
          throw new Error('Nothing left to open');
        }
        // A second call after a failed removal finds the branch built already.
        if (!(await built(r, kept))) await rebuild(r, kept);
        // The branch stays for the task; the worktree and the data go.
        await removeResult(r, false, OPEN_FAILED);
        await d.store.reject(repoId, dropped);
        await d.store.closeJournal(repoId, r.id, {
          as: 'task',
          kept: kept.length,
          dropped: dropped.length,
          taskName: null,
        });
        await d.store.setResult(repoId, null);
        opened.set(key(repoId, r.id), {
          branch: r.branch,
          kept: kept.length,
          dropped: dropped.length,
          until: now() + OPENED_MS,
        });
        d.broadcast();
        return { branch: r.branch };
      }),
  };

  const taskLink: DreamTaskLink = {
    opened(dreamId, repoId, branch) {
      const o = opened.get(key(repoId, dreamId));
      if (o && o.until <= now()) opened.delete(key(repoId, dreamId));
      return !!o && o.until > now() && o.branch === branch;
    },
    async taskCreated(dreamId, repoId, taskName) {
      const o = opened.get(key(repoId, dreamId));
      if (!o) return;
      opened.delete(key(repoId, dreamId));
      await d.store.closeJournal(repoId, dreamId, {
        as: 'task',
        kept: o.kept,
        dropped: o.dropped,
        taskName,
      });
      d.broadcast();
    },
  };

  return { handlers, taskLink };
}
