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
const TEST_FAILED = 'The test could not be run';
const MISMATCH = "The dream's record does not match its folder";
const SETTINGS_FAILED = 'The dream settings could not be saved';
/** A dream's id as the runner makes it (`<YYYY-MM-DD>-<n>`); its branch is `dream/<id>`. */
const DREAM_ID = /^\d{4}-\d{2}-\d{2}-\d+$/;

/** A fixed phrase for the renderer. Any other error is logged and replaced by the handler's own phrase. */
class Refusal extends Error {}
const refuse = (message: string) => new Refusal(message);

/** Runs `fn`; an error that is not a `Refusal` (a disk or git error, which may name a path) becomes `message`. */
async function phrased<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Refusal) throw e;
    console.error(`[dreams] ${message}`, e);
    throw refuse(message);
  }
}

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) =>
    process.platform === 'win32'
      ? path.resolve(p).toLowerCase()
      : path.resolve(p);
  return norm(a) === norm(b);
};

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
    /** The one way `dreaming` is written (`SettingsStore.updateDreaming`). */
    updateDreaming(
      fn: (current: DreamingSettings) => DreamingSettings,
    ): Promise<AppSettings>;
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
    if (!s) throw refuse('Dreams are still starting');
    return s;
  };

  const saveDreaming = async (
    fn: (cur: DreamingSettings) => DreamingSettings,
  ): Promise<DreamingSettings> =>
    (await d.settings.updateDreaming(fn)).dreaming;

  const openResult = (repoId: string): DreamResult => {
    const r = d.store.repo(repoId).result;
    if (!r) throw refuse('This repo has no dream to review');
    return r;
  };

  /**
   * The stored result as the runner made it, checked before anything acts on its paths: this repo's id, an id and
   * branch of the runner's shape, and worktree and data at `<dreamsDir>/<repoId>/<id>/{wt,data}`. A hand-edited or
   * damaged record never reaches git or a removal. Returns the dream's folder and what its worktree is:
   * - `live`: `wt` is a git worktree of its own (git's top level for it is `wt` itself) on the dream branch;
   * - `gone`: no such worktree (removed, or half removed: a `wt` folder whose `.git` is gone, where git would walk up
   *   into an enclosing repo). No git command then runs with `wt` as its folder.
   * A real worktree on another branch is refused.
   */
  const checked = async (
    repoId: string,
    r: DreamResult,
  ): Promise<{ dir: string; worktree: 'live' | 'gone' }> => {
    const plainId = (x: string) =>
      x !== '' &&
      x !== '.' &&
      x !== '..' &&
      path.basename(x) === x &&
      !/[\\/]/.test(x);
    if (
      r.repoId !== repoId ||
      !plainId(repoId) ||
      !DREAM_ID.test(r.id) ||
      r.branch !== `dream/${r.id}`
    )
      throw refuse(MISMATCH);
    const real = await fs.realpath(d.dreamsDir).catch(() => d.dreamsDir);
    const dir = [d.dreamsDir, real]
      .map((root) => path.join(root, repoId, r.id))
      .find(
        (x) =>
          samePath(r.worktreePath, path.join(x, 'wt')) &&
          samePath(r.dataDir, path.join(x, 'data')),
      );
    if (!dir) throw refuse(MISMATCH);
    if (!(await pathExists(r.worktreePath))) return { dir, worktree: 'gone' };
    // Read-only, to learn whether `wt` is a worktree of its own; nothing else runs there unless it is.
    const top = await d.git
      .run(r.worktreePath, ['rev-parse', '--show-toplevel'])
      .then(
        (x) => fs.realpath(x.trim()),
        () => null,
      );
    const wtReal = await fs.realpath(r.worktreePath).catch(() => null);
    if (top === null || wtReal === null || !samePath(top, wtReal))
      return { dir, worktree: 'gone' };
    const head = await d.git
      .run(r.worktreePath, ['symbolic-ref', '--short', 'HEAD'])
      .then(
        (x) => x.trim(),
        () => null,
      );
    if (head !== r.branch) throw refuse(MISMATCH);
    return { dir, worktree: 'live' };
  };

  /**
   * Removes what the result made: its folder (`dir`, from `checked`), and with `branch` its branch. Throws a fixed
   * phrase on a failure.
   */
  const removeResult = async (
    r: DreamResult,
    dir: string,
    branch: boolean,
    message: string,
  ) => {
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
      throw refuse(message);
    }
  };

  const discard = async (repoId: string, r: DreamResult, dir: string) => {
    await removeResult(r, dir, true, 'The dream could not be removed');
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
    if (!(await pathExists(wt))) throw refuse(OPEN_FAILED);
    let c: string[];
    let tip: string;
    try {
      const hooks = path.join(path.dirname(wt), 'hooks');
      await fs.mkdir(hooks, { recursive: true });
      const base = unattendedConfig(hooks);
      c = flags([...base, ...(await authorConfig(d.git, wt, base))]);
      tip = (await d.git.run(wt, [...c, 'rev-parse', 'HEAD'])).trim();
    } catch {
      throw refuse(OPEN_FAILED);
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
      throw refuse(OPEN_FAILED);
    }
  };

  /** One call with the model, as a dream makes it, in an empty folder; null when the model alone answered. */
  const testCall = async (model: string): Promise<string | null> => {
    let root: string;
    try {
      root = await fs.mkdtemp(
        path.join(d.tmpDir ?? os.tmpdir(), 'shellie-dream-test-'),
      );
    } catch (e) {
      console.error('[dreams] the test folder could not be made', e);
      return TEST_FAILED;
    }
    try {
      const worktree = path.join(root, 'wt');
      const dataDir = path.join(root, 'data');
      let cwd: string;
      try {
        await fs.mkdir(worktree);
        await fs.mkdir(dataDir);
        cwd = await fs.realpath(worktree);
      } catch (e) {
        console.error('[dreams] the test folder could not be made', e);
        return TEST_FAILED;
      }
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
    'dream:get': () =>
      phrased('Dreams could not be read', async (): Promise<DreamView> => {
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
      }),

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
        await phrased(SETTINGS_FAILED, () =>
          saveDreaming((cur) => ({
            ...cur,
            model,
            testedModel: model,
            // A new model is confirmed again before it dreams.
            enabled: cur.model === model ? cur.enabled : false,
          })),
        );
        d.broadcast();
        return { ok: true };
      } catch (e) {
        console.error('[dreams] the test could not be run', e);
        return {
          ok: false,
          message: e instanceof Refusal ? e.message : TEST_FAILED,
        };
      } finally {
        testing = false;
      }
    },

    'dream:save': (next, acknowledged) =>
      phrased(SETTINGS_FAILED, async () => {
        const parsed = DreamingSettingsSchema.safeParse(next);
        if (!parsed.success) throw refuse('These dream settings are not valid');
        const known = new Set(d.repos().map((r) => r.id));
        let wasOn = false;
        const saved = await saveDreaming((prev) => {
          wasOn = prev.enabled;
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
            throw refuse('Confirm the change first');
          // A narrowing that leaves no limit or no repo to dream about switches dreaming off with it.
          return {
            ...merged,
            enabled: merged.enabled && canSwitchOn(merged) === null,
          };
        });
        // As `dream:switchOff`: no more calls once dreaming is off or the running dream's repo is unticked.
        const running = status()?.running ?? null;
        if (
          (wasOn && !saved.enabled) ||
          (running && saved.repos[running.repoId]?.on !== true)
        )
          d.scheduler()?.stopDream();
        d.broadcast();
        return saved;
      }),

    'dream:switchOn': (acknowledged) =>
      phrased(SETTINGS_FAILED, async () => {
        const reason = canSwitchOn(d.settings.get().dreaming);
        if (reason)
          throw refuse(`Dreaming cannot be switched on yet: ${reason}`);
        if (acknowledged !== true) throw refuse('Tick the box first');
        await started().switchOn(async () => {
          await saveDreaming((cur) => {
            // Checked again as the write runs: a save queued meanwhile may have changed the settings.
            const again = canSwitchOn(cur);
            if (again)
              throw refuse(`Dreaming cannot be switched on yet: ${again}`);
            return { ...cur, enabled: true };
          });
        });
        d.broadcast();
        return d.settings.get().dreaming;
      }),

    'dream:switchOff': () =>
      phrased(SETTINGS_FAILED, async () => {
        const saved = await saveDreaming((cur) => ({ ...cur, enabled: false }));
        // Switched off means no model calls: a dream that runs now stops too.
        d.scheduler()?.stopDream();
        d.broadcast();
        return saved;
      }),

    // The scheduler decides, as for its own checks, and sends `dream:changed` when a dream starts or ends.
    'dream:now': (repoId) =>
      phrased('The dream could not be started', () =>
        started().dreamNow(repoId),
      ),

    'dream:stop': async () => {
      d.scheduler()?.stopDream();
    },

    'dream:drop': (repoId, proposalId, dropped) =>
      serial(() =>
        phrased('The dream could not be saved', async () => {
          started();
          if (!openResult(repoId).proposals.some((p) => p.id === proposalId))
            throw refuse('This dream has no such proposal');
          await d.store.setDropped(repoId, proposalId, dropped === true);
          d.broadcast();
        }),
      ),

    'dream:discard': (repoId) =>
      serial(() =>
        phrased('The dream could not be saved', async () => {
          started();
          const r = openResult(repoId);
          await discard(repoId, r, (await checked(repoId, r)).dir);
        }),
      ),

    'dream:openAsTask': (repoId) =>
      serial(() =>
        phrased(OPEN_FAILED, async () => {
          started();
          const r = openResult(repoId);
          // Before any git or removal: the record must be the dream's own.
          const { dir, worktree } = await checked(repoId, r);
          const kept = r.proposals.filter((p) => !p.dropped);
          const dropped = r.proposals.filter((p) => p.dropped);
          if (kept.length === 0) {
            await discard(repoId, r, dir);
            throw refuse('Nothing left to open');
          }
          // A second call after a failed removal finds the branch built already. Without a live worktree there is
          // nothing to build in: it goes on only when the branch is built.
          if (!(await built(r, kept))) {
            if (worktree !== 'live') throw refuse(OPEN_FAILED);
            await rebuild(r, kept);
          }
          // The branch stays for the task; the worktree and the data go.
          await removeResult(r, dir, false, OPEN_FAILED);
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
      ),
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
