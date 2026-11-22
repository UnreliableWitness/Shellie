/**
 * The `dream:*` IPC handlers (spec sections 1, 5 and 8). The renderer is not trusted to switch dreaming on: `enabled`
 * becomes true only through `dream:switchOn`, with every step done and the owner's tick; `dream:save` never takes
 * `enabled`, `model` or `testedModel`, and a change that widens dreaming while it is on needs the tick again.
 *
 * Messages are fixed phrases: never a run's output, session text, a path or git's own errors.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isOpencodeModel } from '../../shared/brain';
import {
  canSwitchOn,
  DreamingSettingsSchema,
  DreamRepoSchema,
  widens,
  type DreamingSettings,
  type DreamProposal,
  type DreamResult,
  type DreamUsage,
  type DreamView,
  dreamingOf,
  pruneDreaming,
  projectsOnModel,
  type DreamingAll,
  dreamBriefing,
} from '../../shared/dreams';
import type { Handlers } from '../../shared/ipc';
import type { AppSettings } from '../../shared/usage';
import { pathExists, removeTree } from '../fsRetry';
import type { Platform } from '../platform/Platform';
import { samePath } from '../paths';
import { configFlags, type GitClient } from '../services/GitClient';
import { programMissing, type runWithInput } from '../services/prSummary';
import type { DreamStore } from './DreamStore';
import { DREAM_READ_TIMEOUT_MS, proposalDiff, proposalFile } from './dreamDiff';
import {
  authorConfig,
  DREAM_TEST_PREFIX,
  removeDream,
  unattendedConfig,
} from './dreamGit';
import { sessionOf } from './dreamRun';
import { enabledProps, sendSafely, type DreamEvent } from './dreamTelemetry';
import { hasPrice } from './limit';
import type { OpencodeModelList } from './models';
import { dreamArgs, dreamEnv, otherModels } from './opencodeDream';
import type { DreamScheduler } from './scheduler';

export const DREAM_TEST_TIMEOUT_MS = 2 * 60_000;
/** The test call's prompt: tiny and fixed. */
export const DREAM_TEST_PROMPT = 'Reply with the single word: ok';

const OPEN_FAILED = 'The dream could not be opened as a task';
const PUBLISH_FAILED = 'The dream could not be sent';
const NO_OPENED = 'This repo has no dream branch waiting for a task';
const TEST_FAILED = 'The test could not be run';
const MISMATCH = "The dream's record does not match its folder";
const SETTINGS_FAILED = 'The dream settings could not be saved';
const DIFF_FAILED = 'The changes could not be read';
/** A full commit id (SHA-1 or SHA-256): never an option or a revision expression. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A dream's id as the runner makes it (`<YYYY-MM-DD>-<n>`); its branch is `dream/<id>`. */
const DREAM_ID = /^\d{4}-\d{2}-\d{2}-\d+$/;

/** A fixed phrase for the renderer. Any other error is logged and replaced by the handler's own phrase. */
class Refusal extends Error {}
const refuse = (message: string) => new Refusal(message);
/** A fixed phrase from the code that sends a dream's branch (`DreamApi.publish`): it reaches the renderer as it is. */
export const dreamRefusal = (message: string): Error => refuse(message);

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

/**
 * The dream calls answered here. `dream:pr` and `dream:prTarget` are answered beside the tasks' own push and pull
 * request code (`src/main/ipc/handlers.ts`), through `DreamApi.publish`.
 */
export type DreamChannel = Exclude<
  Extract<keyof Handlers, `dream:${string}`>,
  'dream:pr' | 'dream:prTarget'
>;
export type DreamHandlers = Pick<Handlers, DreamChannel>;

/** What `tasks:create` asks about a `fromDream` task. */
export type DreamTaskLink = {
  /** True when the repo's stored `opened` record (`dream:openAsTask`) is this dream's, on `branch`. No time limit. */
  opened(dreamId: string, repoId: string, branch: string): boolean;
  /** The task was made: the record is cleared and the journal names the task. */
  taskCreated(dreamId: string, repoId: string, taskName: string): Promise<void>;
  /** What the task's agents are told about the dream (`dreamBriefing`); null for a record that does not hold it. */
  briefing(dreamId: string, repoId: string): string | null;
};

/** The open result's branch, built from the kept proposals and ready to be pushed. */
export type DreamToSend = {
  repoPath: string;
  /** The dream's own worktree, on `branch`. */
  worktreePath: string;
  branch: string;
  baseSha: string;
  kept: { title: string; why: string; files: string[] }[];
};

/** How a dream's branch left the machine. */
export type DreamSent =
  | { as: 'pr'; pr: { id: number; url: string } }
  | { as: 'pushed' };

type Repo = {
  id: string;
  name: string;
  path: string;
  /** The repo's project; a repo without one does not dream. */
  connectionId: string | null;
};

export type DreamApi = {
  handlers: DreamHandlers;
  taskLink: DreamTaskLink;
  /**
   * The repo was removed from Shellie (`repos:remove`): its running dream is stopped, its open result discarded, its
   * `opened` record forgotten (the branch stays), its entry removed from the settings and its stored state forgotten.
   * The journal keeps its past entries. Best effort: never throws.
   */
  repoRemoved(repo: Repo): Promise<void>;
  /**
   * Create pull request (`dream:pr`): the open result's branch is made the base plus the kept proposals, `send`
   * pushes it and makes the pull request, and the dream closes (dropped proposals remembered as rejected, the
   * worktree, data and local branch removed, the journal naming the pull request or the branch). All in the chain of
   * the result's changes, so no drop or discard lands in between. A failing `send` leaves the result open; what it
   * throws with `dreamRefusal` reaches the renderer as it is.
   */
  publish(
    repoId: string,
    send: (ready: DreamToSend) => Promise<DreamSent>,
  ): Promise<DreamSent & { branch: string }>;
  /**
   * A repo moved to another project, or a project was removed: the dream settings lose what no longer belongs in
   * them (`pruneDreaming`), a removed project's switch-off record goes, and a dream running for a repo that left
   * its block stops. Best effort: never throws.
   */
  projectsChanged(): Promise<void>;
};

export type DreamHandlerDeps = {
  settings: {
    get(): AppSettings;
    /** The one way `dreaming` is written (`SettingsStore.updateDreaming`). */
    updateDreaming(
      fn: (current: DreamingAll) => DreamingAll,
    ): Promise<AppSettings>;
  };
  /** The connection ids that exist: a dream call names one of them. */
  projects: () => string[];
  store: DreamStore;
  /** Null until the scheduler started (the store is loaded then); only reads are answered before. */
  scheduler: () => Pick<
    DreamScheduler,
    | 'dreamNow'
    | 'stopDream'
    | 'stopDreamOf'
    | 'status'
    | 'switchOn'
    | 'switchOffModel'
    | 'runningDream'
  > | null;
  repos: () => Repo[];
  git: Pick<
    GitClient,
    'run' | 'branchExists' | 'worktreeRemove' | 'worktreePrune'
  >;
  platform: Pick<Platform, 'opencodeCommand'>;
  /** The spawn helper the runner uses (main: the pty host's); it kills the process on its timeout. */
  run: typeof runWithInput;
  /** The models of every assistant message of a session and its child sessions. */
  sessionModels: (sessionId: string) => string[];
  /** OpenCode's model list, shared with the scheduler: `dream:get` only reads what is known, `dream:test` may ask. */
  models: Pick<OpencodeModelList, 'known' | 'get'>;
  /** Today's dream usage of a project (`limitChecks(...).usage`). */
  usage: (project: string) => DreamUsage;
  /** Every dream's folder lies in it; nothing outside it is ever removed. */
  dreamsDir: string;
  /** Sends `dream:changed`. */
  broadcast: () => void;
  now?: () => number;
  /** `dream.enabled`, `dream.switched_off`, `dream.test`, `dream.result` (`docs/telemetry.md`); none when absent. */
  event?: DreamEvent;
};

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
      'dream:leaveBranch': no,
      'dream:folderExists': no,
      'dream:diff': no,
      'dream:file': no,
    },
    taskLink: {
      opened: () => false,
      taskCreated: async () => undefined,
      briefing: () => null,
    },
    repoRemoved: async () => undefined,
    publish: no,
    projectsChanged: async () => undefined,
  };
}

/** How long a removed repo's running dream may take to end before its result and state are forgotten anyway. */
const REMOVED_STOP_MS = 15_000;

export function createDreamHandlers(d: DreamHandlerDeps): DreamApi {
  const now = d.now ?? Date.now;
  const event: DreamEvent = (name, props) => sendSafely(d.event, name, props);
  let testing = false;
  // Drop, discard and open as task change the open result: one after another.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => undefined);
    return p;
  };

  /** The scheduler, for a call that writes the dream store: it is loaded once the scheduler started. */
  const started = () => {
    const s = d.scheduler();
    if (!s) throw refuse('Dreams are still starting');
    return s;
  };

  /** The project a call names: a connection that exists. */
  const projectOf = (connectionId: unknown): string => {
    if (
      typeof connectionId !== 'string' ||
      !d.projects().includes(connectionId)
    )
      throw refuse('This project is not known');
    return connectionId;
  };

  /** Writes one project's dream settings; `before` is what the write started from. */
  const saveDreaming = async (
    project: string,
    fn: (cur: DreamingSettings) => DreamingSettings,
  ): Promise<{ before: DreamingSettings; after: DreamingSettings }> => {
    const seen: { before?: DreamingSettings } = {};
    const all = (
      await d.settings.updateDreaming((cur) => {
        // The setup of before dreams were per project is still to be split over the projects (at the start): a
        // block written now would win over this project's copy and lose it.
        if (cur.legacy !== null) throw refuse('Dreams are still starting');
        seen.before = dreamingOf(cur, project);
        return {
          ...cur,
          projects: { ...cur.projects, [project]: fn(seen.before) },
        };
      })
    ).dreaming;
    const after = dreamingOf(all, project);
    return { before: seen.before ?? after, after };
  };

  /** A narrowing that leaves no limit or no repo to dream about switches dreaming off with it. */
  const narrowed = (s: DreamingSettings): DreamingSettings => ({
    ...s,
    enabled: s.enabled && canSwitchOn(s) === null,
  });

  const repoOf = (id: string) => d.repos().find((x) => x.id === id);

  /** Removes a folder; the failure when it could not be removed, else null. */
  const tried = (dir: string): Promise<unknown> =>
    removeTree(dir).then(
      () => null,
      (e: unknown) => e,
    );

  /** The journal and the event of a result closed as discarded. */
  const closeDiscarded = async (repoId: string, r: DreamResult) => {
    await d.store.closeJournal(repoId, r.id, {
      as: 'discarded',
      kept: 0,
      dropped: r.proposals.length,
      taskName: null,
    });
    event('dream.result', {
      kept: 0,
      dropped: r.proposals.length,
      outcome: 'discarded',
    });
  };

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
    const c = configFlags(unattendedConfig(path.join(dir, 'hooks')));
    // Read-only, to learn whether `wt` is a worktree of its own; nothing else runs there unless it is.
    const top = await d.git
      .run(r.worktreePath, [...c, 'rev-parse', '--show-toplevel'], {
        timeoutMs: DREAM_READ_TIMEOUT_MS,
      })
      .then(
        (x) => fs.realpath(x.trim()),
        () => null,
      );
    const wtReal = await fs.realpath(r.worktreePath).catch(() => null);
    if (top === null || wtReal === null || !samePath(top, wtReal))
      return { dir, worktree: 'gone' };
    const head = await d.git
      .run(r.worktreePath, [...c, 'symbolic-ref', '--short', 'HEAD'], {
        timeoutMs: DREAM_READ_TIMEOUT_MS,
      })
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
    /** The repo when Shellie no longer lists it (it is being removed). */
    gone?: Repo,
  ) => {
    const repo = gone ?? repoOf(r.repoId);
    const failure = repo
      ? await removeDream(
          d.git,
          repo.path,
          {
            dir,
            worktree: r.worktreePath,
            branch: branch ? r.branch : null,
          },
          unattendedConfig(path.join(dir, 'hooks')),
        )
      : await tried(dir);
    // Inside the folder as the runner makes it; removed on its own should a result say otherwise.
    const data = failure ? null : await tried(r.dataDir);
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
    event('dream.result', {
      kept: 0,
      dropped: r.proposals.length,
      outcome: 'discarded',
    });
    d.broadcast();
  };

  /**
   * Whether the branch already is the base plus the kept proposals' changes, one commit each: nothing dropped, or an
   * earlier call rebuilt it and then failed to remove the worktree. Asked in the repo (read-only git, no hooks), so it
   * also answers once the worktree is gone. Any doubt is false.
   */
  const built = async (r: DreamResult, kept: DreamProposal[], dir: string) => {
    const repo = repoOf(r.repoId);
    if (!repo) return false;
    const ref = `refs/heads/${r.branch}`;
    const c = configFlags(unattendedConfig(path.join(dir, 'hooks')));
    try {
      await d.git.run(repo.path, [
        ...c,
        'merge-base',
        '--is-ancestor',
        r.baseSha,
        ref,
      ]);
      const count = (
        await d.git.run(repo.path, [
          ...c,
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
          ...c,
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
  const rebuild = async (
    r: DreamResult,
    kept: DreamProposal[],
    failed = OPEN_FAILED,
  ) => {
    const wt = r.worktreePath;
    if (!(await pathExists(wt))) throw refuse(failed);
    let c: string[];
    let tip: string;
    try {
      const hooks = path.join(path.dirname(wt), 'hooks');
      await fs.mkdir(hooks, { recursive: true });
      const base = unattendedConfig(hooks);
      c = configFlags([...base, ...(await authorConfig(d.git, wt, base))]);
      tip = (await d.git.run(wt, [...c, 'rev-parse', 'HEAD'])).trim();
    } catch {
      throw refuse(failed);
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
      throw refuse(failed);
    }
  };

  /**
   * The repo, the dream's folder and the commit of a proposal of the open result, for reading its changes. Before
   * any git: the record must be the dream's own (`checked`) and the commit a plain id.
   */
  const proposalSource = async (repoId: string, proposalId: string) => {
    const r = openResult(repoId);
    const p = r.proposals.find((x) => x.id === proposalId);
    if (!p) throw refuse('This dream has no such proposal');
    const { dir } = await checked(repoId, r);
    if (!FULL_SHA.test(p.commit)) throw refuse(MISMATCH);
    const repo = repoOf(repoId);
    if (!repo) throw refuse(DIFF_FAILED);
    return {
      repoPath: repo.path,
      config: unattendedConfig(path.join(dir, 'hooks')),
      commit: p.commit,
    };
  };

  /**
   * One call with the model, as a dream makes it, in an empty folder; null when the model alone answered, else the
   * fixed phrase and, when another model answered, which. The folder lies in the dreams folder, so the ledger counts
   * its usage as a dream's (never sent to the cost server).
   */
  const testCall = async (
    model: string,
    project: string,
  ): Promise<{ message: string; others?: string[] } | null> => {
    let root: string;
    try {
      await fs.mkdir(d.dreamsDir, { recursive: true });
      root = await fs.mkdtemp(path.join(d.dreamsDir, DREAM_TEST_PREFIX));
    } catch (e) {
      console.error('[dreams] the test folder could not be made', e);
      return { message: TEST_FAILED };
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
        return { message: TEST_FAILED };
      }
      const cmd = d.platform.opencodeCommand(
        undefined,
        dreamArgs(model, 'test', project),
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
        if (programMissing(e)) return { message: 'OpenCode was not found' };
        if (/timed out/i.test((e as Error | null)?.message ?? ''))
          return { message: 'The test timed out' };
        return { message: `${model} did not answer` };
      }
      let answered: string[];
      try {
        const session = sessionOf(stdout);
        answered = session ? d.sessionModels(session) : [];
      } catch {
        answered = [];
      }
      if (answered.length === 0) return { message: `${model} did not answer` };
      const others = otherModels(answered, model);
      if (others.length > 0)
        return { message: 'Another model answered', others };
      return null;
    } finally {
      await removeTree(root).catch((e: unknown) =>
        console.error('[dreams] the test folder could not be removed', e),
      );
    }
  };

  /**
   * A re-test of the project's saved model failed. Another model answered (`others`): as after a dream answered by
   * another model, every project that dreams on the model gets the switch-off record, goes off and forgets the
   * passed test. Any other failure: this project goes off and forgets the test, so setup asks to test the model
   * first; no record. A running dream of a project that went off stops.
   */
  const retestFailed = async (
    project: string,
    model: string,
    others: string[] | null,
  ) => {
    const s = d.scheduler();
    if (others && s) {
      // The scheduler's own rule, in its chain: one write, and the switch-off holds even when it cannot be recorded.
      // A test call is no repo's.
      await s.switchOffModel({
        project,
        model,
        answered: others.join(', '),
        repoId: '',
      });
      d.broadcast();
      return;
    }
    // Before the scheduler started the dream store is not loaded: no record, the settings hold on their own.
    const affected = others
      ? [
          ...new Set([
            project,
            ...projectsOnModel(d.settings.get().dreaming, model),
          ]),
        ]
      : [project];
    let wasOn = false;
    for (const p of affected) {
      const { before } = await saveDreaming(p, (cur) =>
        // Still the model that was tested: a new pick saved meanwhile is left alone.
        cur.model !== model
          ? cur
          : { ...cur, enabled: false, testedModel: null },
      );
      wasOn ||= before.enabled;
      s?.stopDream(p);
    }
    if (wasOn)
      event('dream.switched_off', {
        by: others ? 'wrong-model' : 'test-failed',
      });
    d.broadcast();
  };

  const usageNow = (project: string): DreamUsage => {
    try {
      return d.usage(project);
    } catch (e) {
      console.error('[dreams] today’s usage could not be read', e);
      return { day: '', tokens: 0, eur: null };
    }
  };

  const status = (project: string) => {
    try {
      return d.scheduler()?.status(project) ?? null;
    } catch (e) {
      console.error('[dreams] the scheduler status could not be read', e);
      return null;
    }
  };

  const handlers: DreamHandlers = {
    'dream:get': (connectionId) =>
      phrased('Dreams could not be read', async (): Promise<DreamView> => {
        const project = projectOf(connectionId);
        const settings = dreamingOf(d.settings.get().dreaming, project);
        const st = status(project);
        // The project's repos, and a repo without a project that still has something to review.
        const shown = d.repos().flatMap((r) => {
          if (r.connectionId === project) return [{ r, orphan: false }];
          if (r.connectionId !== null) return [];
          const state = d.store.repo(r.id);
          return state.result || state.opened ? [{ r, orphan: true }] : [];
        });
        const repos = await Promise.all(
          shown.map(async ({ r, orphan }) => ({
            id: r.id,
            name: r.name,
            ...(orphan ? { orphan } : {}),
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
        const ids = new Set(repos.map((r) => r.id));
        return {
          settings,
          // Never asked here: only what the scheduler or another screen already read.
          models: d.models.known(),
          euroLimitOffered: settings.model !== null && hasPrice(settings.model),
          usage: usageNow(project),
          waiting: st?.wait ?? null,
          next: st?.next ?? null,
          running: st?.running ?? null,
          switchedOff: d.store.switchedOff(project),
          repos,
          journal: d.store.journal().filter((e) => ids.has(e.repoId)),
        };
      }),

    'dream:test': async (connectionId, model) => {
      if (testing) return { ok: false, message: 'A test is already running' };
      testing = true;
      let ok = false;
      try {
        const project = projectOf(connectionId);
        const listed = async (fresh: boolean) =>
          (await d.models.get(fresh))?.includes(model) ?? false;
        const failure =
          typeof model !== 'string' ||
          !isOpencodeModel(model) ||
          !((await listed(false)) || (await listed(true)))
            ? { message: `${String(model)} is not available in OpenCode` }
            : await testCall(model, project);
        if (failure) {
          // A failed re-test of the dreaming model is not ignored: the next dream would spend a whole run first.
          if (dreamingOf(d.settings.get().dreaming, project).model === model)
            await phrased(SETTINGS_FAILED, () =>
              retestFailed(project, model, failure.others ?? null),
            );
          return { ok: false, message: failure.message };
        }
        const { before } = await phrased(SETTINGS_FAILED, () =>
          saveDreaming(project, (cur) => ({
            ...cur,
            model,
            testedModel: model,
            // A new model is confirmed again before it dreams.
            enabled: cur.model === model ? cur.enabled : false,
          })),
        );
        // A dream still running on the old model stops with it.
        if (before.enabled && before.model !== model)
          d.scheduler()?.stopDream(project);
        d.broadcast();
        ok = true;
        return { ok: true };
      } catch (e) {
        console.error('[dreams] the test could not be run', e);
        return {
          ok: false,
          message: e instanceof Refusal ? e.message : TEST_FAILED,
        };
      } finally {
        testing = false;
        event('dream.test', { ok });
      }
    },

    'dream:save': (connectionId, next, acknowledged) =>
      phrased(SETTINGS_FAILED, async () => {
        const project = projectOf(connectionId);
        const parsed = DreamingSettingsSchema.safeParse(next);
        if (!parsed.success) throw refuse('These dream settings are not valid');
        const home = new Map(d.repos().map((r) => [r.id, r.connectionId]));
        // A repo Shellie no longer knows is dropped; one of another project (or of none) is refused.
        const named = Object.entries(parsed.data.repos).filter(([id]) =>
          home.has(id),
        );
        if (named.some(([id]) => home.get(id) !== project))
          throw refuse('A repo of another project cannot dream here');
        const { before, after: saved } = await saveDreaming(project, (prev) => {
          const merged: DreamingSettings = {
            ...parsed.data,
            enabled: prev.enabled,
            model: prev.model,
            testedModel: prev.testedModel,
            repos: Object.fromEntries(named),
          };
          if (prev.enabled && widens(prev, merged) && acknowledged !== true)
            throw refuse('Confirm the change first');
          return narrowed(merged);
        });
        const wasOn = before.enabled;
        // As `dream:switchOff`: no more calls once dreaming is off or the running dream's repo is unticked.
        const running = status(project)?.running ?? null;
        if (wasOn && !saved.enabled)
          event('dream.switched_off', { by: 'narrowed' });
        if (
          (wasOn && !saved.enabled) ||
          (running && saved.repos[running.repoId]?.on !== true)
        )
          d.scheduler()?.stopDream(project);
        d.broadcast();
        return saved;
      }),

    'dream:switchOn': (connectionId, acknowledged) =>
      phrased(SETTINGS_FAILED, async () => {
        const project = projectOf(connectionId);
        const reason = canSwitchOn(
          dreamingOf(d.settings.get().dreaming, project),
        );
        if (reason)
          throw refuse(`Dreaming cannot be switched on yet: ${reason}`);
        if (acknowledged !== true) throw refuse('Tick the box first');
        let on: DreamingSettings | null = null;
        await started().switchOn(project, async () => {
          ({ after: on } = await saveDreaming(project, (cur) => {
            // Checked again as the write runs: a save queued meanwhile may have changed the settings.
            const again = canSwitchOn(cur);
            if (again)
              throw refuse(`Dreaming cannot be switched on yet: ${again}`);
            return { ...cur, enabled: true };
          }));
        });
        if (on) event('dream.enabled', enabledProps(on));
        d.broadcast();
        return dreamingOf(d.settings.get().dreaming, project);
      }),

    'dream:switchOff': (connectionId) =>
      phrased(SETTINGS_FAILED, async () => {
        const project = projectOf(connectionId);
        const { before, after: saved } = await saveDreaming(project, (cur) => ({
          ...cur,
          enabled: false,
        }));
        if (before.enabled) event('dream.switched_off', { by: 'owner' });
        // Switched off means no model calls: a dream of the project that runs now stops too.
        d.scheduler()?.stopDream(project);
        d.broadcast();
        return saved;
      }),

    // The scheduler decides, as for its own checks, and sends `dream:changed` when a dream starts or ends.
    'dream:now': (repoId) =>
      phrased('The dream could not be started', () =>
        started().dreamNow(repoId),
      ),

    'dream:stop': async (connectionId) => {
      if (typeof connectionId === 'string')
        d.scheduler()?.stopDream(connectionId);
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
          if (!(await built(r, kept, dir))) {
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
          // The result goes and its branch is remembered in one write: until a task is made from it (also after a
          // restart), Dreams offers to make it.
          await d.store.openedAsTask(repoId, {
            dreamId: r.id,
            branch: r.branch,
            at: new Date(now()).toISOString(),
            kept: kept.length,
            titles: kept.map((p) => p.title),
            proposals: kept.map((p) => ({
              title: p.title,
              why: p.why,
              files: p.files,
              evidence: p.evidence,
            })),
          });
          event('dream.result', {
            kept: kept.length,
            dropped: dropped.length,
            outcome: 'task',
          });
          d.broadcast();
          return { branch: r.branch };
        }),
      ),

    'dream:leaveBranch': (repoId) =>
      serial(() =>
        phrased('The dream could not be saved', async () => {
          started();
          if (!d.store.repo(repoId).opened) throw refuse(NO_OPENED);
          // Only the record: the branch is the owner's now and is never deleted here.
          await d.store.setOpened(repoId, null);
          d.broadcast();
        }),
      ),

    // Read-only git in a known repo's own tree: no file-system walk, the folder checked by the settings' schema first.
    'dream:folderExists': (repoId, folder) =>
      phrased('The folder could not be checked', async () => {
        if (!DreamRepoSchema.shape.folders.element.safeParse(folder).success)
          throw refuse('This is not a folder a dream may change');
        const repo = repoOf(repoId);
        if (!repo) throw refuse('Unknown repo');
        const c = configFlags([
          ...unattendedConfig(path.join(d.dreamsDir, '.no-hooks')),
          'core.ignorecase=false',
        ]);
        const out = await d.git
          .run(
            repo.path,
            [
              ...c,
              '--literal-pathspecs',
              'ls-tree',
              '-z',
              '--name-only',
              'HEAD',
              '--',
              folder,
            ],
            { timeoutMs: DREAM_READ_TIMEOUT_MS },
          )
          .catch((e: unknown) => {
            // No HEAD yet, or git failed: no warning rather than a wrong one.
            console.error('[dreams] a folder could not be checked', e);
            return null;
          });
        return out === null || out.split('\0').includes(folder);
      }),

    // Reads: not one after another with the changes, and answered before the scheduler started.
    'dream:diff': (repoId, proposalId) =>
      phrased(DIFF_FAILED, async () => {
        const src = await proposalSource(repoId, proposalId);
        return proposalDiff(d.git, src.repoPath, src.config, src.commit);
      }),

    'dream:file': (repoId, proposalId, file) =>
      phrased(DIFF_FAILED, async () => {
        const src = await proposalSource(repoId, proposalId);
        const texts =
          typeof file === 'string'
            ? await proposalFile(
                d.git,
                src.repoPath,
                src.config,
                src.commit,
                file,
              )
            : null;
        if (!texts) throw refuse('This proposal does not change that file');
        return texts;
      }),
  };

  const taskLink: DreamTaskLink = {
    opened(dreamId, repoId, branch) {
      const o = d.store.repo(repoId).opened;
      return o !== null && o.dreamId === dreamId && o.branch === branch;
    },
    briefing(dreamId, repoId) {
      const o = d.store.repo(repoId).opened;
      return o?.dreamId === dreamId && o.proposals && o.proposals.length > 0
        ? dreamBriefing(o.proposals, o.branch)
        : null;
    },
    async taskCreated(dreamId, repoId, taskName) {
      if (d.store.repo(repoId).opened?.dreamId !== dreamId) return;
      await d.store.taskMade(repoId, dreamId, taskName);
      d.broadcast();
    },
  };

  const repoRemoved = (repo: Repo): Promise<void> =>
    serial(async () => {
      const s = d.scheduler();
      await s
        ?.stopDreamOf(repo.id, REMOVED_STOP_MS)
        .catch((e: unknown) =>
          console.error('[dreams] the dream of a removed repo did not end', e),
        );
      // The store is loaded once the scheduler started; before, the next launch's sweep forgets the repo.
      if (s) {
        const r = d.store.repo(repo.id).result;
        if (r) {
          await checked(repo.id, r)
            .then(({ dir }) =>
              removeResult(
                r,
                dir,
                true,
                'The dream could not be removed',
                repo,
              ),
            )
            .catch((e: unknown) =>
              console.error(
                '[dreams] a removed repo’s dream was not removed',
                e,
              ),
            );
          await closeDiscarded(repo.id, r).catch((e: unknown) =>
            console.error('[dreams] journal', e),
          );
        }
        // `opened` goes with the state; its branch is the owner's and stays.
        await d.store
          .forgetRepo(repo.id)
          .catch((e: unknown) =>
            console.error('[dreams] a removed repo was not forgotten', e),
          );
      }
      // Every block that names the repo loses it (its own project's; an older one's when it moved meanwhile).
      for (const [project, block] of Object.entries(
        d.settings.get().dreaming.projects,
      )) {
        if (!(repo.id in block.repos)) continue;
        const saved = await saveDreaming(project, (cur) => {
          const { [repo.id]: _gone, ...repos } = cur.repos;
          return narrowed({ ...cur, repos });
        }).catch((e: unknown) => {
          console.error(
            '[dreams] a removed repo stays in the dream settings',
            e,
          );
          return null;
        });
        if (saved?.before.enabled && !saved.after.enabled) {
          event('dream.switched_off', { by: 'narrowed' });
          s?.stopDream(project);
        }
      }
      d.broadcast();
    });

  const publish: DreamApi['publish'] = (repoId, send) =>
    serial(() =>
      phrased(PUBLISH_FAILED, async () => {
        started();
        const r = openResult(repoId);
        const repo = repoOf(repoId);
        if (!repo) throw refuse(PUBLISH_FAILED);
        // Before any git or removal: the record must be the dream's own.
        const { dir, worktree } = await checked(repoId, r);
        // The push and its secret check run in the dream's own worktree.
        if (worktree !== 'live') throw refuse(PUBLISH_FAILED);
        const kept = r.proposals.filter((p) => !p.dropped);
        const dropped = r.proposals.filter((p) => p.dropped);
        if (kept.length === 0) throw refuse('Nothing left to push');
        if (!(await built(r, kept, dir)))
          await rebuild(r, kept, PUBLISH_FAILED);
        const sent = await send({
          repoPath: repo.path,
          worktreePath: r.worktreePath,
          branch: r.branch,
          baseSha: r.baseSha,
          kept: kept.map((p) => ({
            title: p.title,
            why: p.why,
            files: p.files,
          })),
        });
        // Recorded first: the branch (and the pull request) exist now, whatever fails after this. A failure in
        // these writes leaves the result open, and the next press finds the pushed branch and the pull request.
        await d.store.reject(repoId, dropped);
        await d.store.closeJournal(repoId, r.id, {
          as: sent.as,
          kept: kept.length,
          dropped: dropped.length,
          taskName: null,
          branch: r.branch,
          ...(sent.as === 'pr' ? { pr: sent.pr } : {}),
        });
        await d.store.setResult(repoId, null);
        // The branch is on the remote: the local one goes with the worktree and the data. Best effort: what a
        // locked file keeps here, the sweep at the next launch removes (no open result names it any more).
        await removeResult(r, dir, true, PUBLISH_FAILED).catch(() => undefined);
        event('dream.result', {
          kept: kept.length,
          dropped: dropped.length,
          outcome: sent.as,
        });
        d.broadcast();
        return { ...sent, branch: r.branch };
      }),
    );

  const projectsChanged = (): Promise<void> =>
    serial(async () => {
      const s = d.scheduler();
      const existing = d.projects();
      const before = d.settings.get().dreaming;
      const after = await d.settings
        .updateDreaming((cur) => pruneDreaming(cur, d.repos(), existing))
        .then(
          (x) => x.dreaming,
          (e: unknown) => {
            console.error('[dreams] the dream settings were not pruned', e);
            return null;
          },
        );
      if (after) {
        for (const [project, was] of Object.entries(before.projects))
          if (was.enabled && !after.projects[project]?.enabled)
            event('dream.switched_off', { by: 'narrowed' });
        // A dream of a repo that left its project's block, or of a project that is gone or off, stops. Asked of
        // the scheduler's own record: the repo may be another project's by now.
        const running = s?.runningDream() ?? null;
        const block = running ? after.projects[running.project] : undefined;
        if (
          running &&
          (!block?.enabled || block.repos[running.repoId]?.on !== true)
        )
          s?.stopDream(running.project);
      }
      // The store is loaded once the scheduler started.
      if (s)
        for (const p of d.store.switchedOffProjects())
          if (!existing.includes(p))
            await d.store
              .setSwitchedOff(p, null)
              .catch((e: unknown) =>
                console.error('[dreams] a removed project’s notice stays', e),
              );
      d.broadcast();
    });

  return { handlers, taskLink, repoRemoved, publish, projectsChanged };
}
