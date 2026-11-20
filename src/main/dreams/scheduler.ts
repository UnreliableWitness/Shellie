/**
 * When a dream starts (spec section 2): a check once a minute, the one dream at a time, Dream now, Stop, suspend and
 * quit, and the sweep at launch of what an earlier run left behind. The decision itself is `nextDream`; this module
 * gathers its facts, cheapest first: a repo's sessions are read only once every other check has passed, and kept
 * until something that can change them happens (at most an hour).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { DreamingSettings, DreamSwitchedOff } from '../../shared/dreams';
import type { AppSettings } from '../../shared/usage';
import { pathExists, removeTree } from '../fsRetry';
import { isInside } from '../paths';
import type { GitClient } from '../services/GitClient';
import type { DreamRunner } from './DreamRunner';
import type { DreamStore } from './DreamStore';
import { DREAM_TEST_PREFIX, removeDream, unattendedConfig } from './dreamGit';
import { settledWithin } from './dreamRun';
import type { OpencodeModelList } from './models';
import { runProps, sendSafely, type DreamEvent } from './dreamTelemetry';
import { pickMaterial, type TaskSessions } from './material';
import { nextDream, type ReadyInput, type Wait } from './ready';

export const DREAM_TICK_MS = 60_000;
/**
 * How long a repo's material counts as known without reading its sessions again. Anything that can change it clears
 * it sooner: the dream store, a task (`tasks:changed`), an agent tab of the repo's task reporting, a dream's end.
 */
const MATERIAL_MS = 60 * 60_000;
/** The empty hooks folders of a sweep, inside the dreams folder; one left by a crash goes in the next sweep. */
const SWEEP_PREFIX = '.sweep-';
/** A test call's folder older than this is a crash's leftover (a test gives up after 2 minutes). */
const TEST_LEFT_MS = 5 * 60_000;
/** The branch name a dream gets (`DreamRunner`): `dream/<YYYY-MM-DD>-<n>`. */
const DREAM_BRANCH = /^dream\/\d{4}-\d{2}-\d{2}-\d+$/;

type Repo = { id: string; name: string; path: string };

export type DreamSchedulerDeps = {
  /** Reads `dreaming`; writes only `enabled: false` and `testedModel: null`, after a call answered by another model. */
  settings: {
    get(): AppSettings;
    updateDreaming(
      fn: (current: DreamingSettings) => DreamingSettings,
    ): Promise<unknown>;
  };
  store: DreamStore;
  runner: Pick<DreamRunner, 'dream' | 'running'>;
  /** OpenCode's model list, shared with `dream:get` (`opencodeModelList`). */
  models: Pick<OpencodeModelList, 'known' | 'get'>;
  idleSeconds: () => number;
  onBattery: () => boolean;
  /** Some agent tab's last state is `working`. */
  agentWorking: () => boolean;
  repos: () => Repo[];
  sessionsOf: (repoId: string) => Promise<TaskSessions[]>;
  limit: { hasRoom(): boolean };
  /** Sends `dream:changed`. */
  broadcast: () => void;
  now: () => number;
  git: Pick<
    GitClient,
    | 'run'
    | 'branchExists'
    | 'worktreeRemove'
    | 'worktreePrune'
    | 'deleteBranch'
    | 'worktreeList'
  >;
  /** The dreams folder: every dream's worktree, data and hooks lie in it. */
  dreamsDir: string;
  /** `dream.run` and `dream.switched_off` (`docs/telemetry.md`); none when absent. */
  event?: DreamEvent;
  tick?: number;
};

export type DreamStatus = {
  /** Why no dream starts; null while one runs or before the first check. */
  wait: Wait | null;
  /** The repo that dreams next as far as its material is known, with its count of sessions to read. */
  next: { repoId: string; newSessions: number } | null;
  switchedOff: DreamSwitchedOff | null;
  /** The dream that runs now; null when none does. */
  running: ReturnType<DreamRunner['running']>;
  /** Sessions to read per repo, for the repos whose material is known. */
  newSessions: Record<string, number>;
};

type Known = {
  at: number;
  hasMaterial: boolean;
  newestMaterialAt: number | null;
  sessions: number;
};

export function startDreamScheduler(d: DreamSchedulerDeps) {
  let stopped = false;
  let wait: Wait | null = null;
  let dream: {
    repoId: string;
    stop: AbortController;
    done: Promise<void>;
  } | null = null;
  const material = new Map<string, Known>();
  /** A wrong-model switch-off the dream store could not record: it holds for this session in its place. */
  let offUnrecorded = false;
  // Decisions, Dream now and the sweep run one after another, never side by side.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => undefined);
    return p;
  };
  const unsubscribe = d.store.onChange(() => material.clear());

  const hasRoom = (): boolean => {
    try {
      return d.limit.hasRoom();
    } catch {
      // A usage that cannot be read leaves no room.
      return false;
    }
  };

  /** The repo's material, read again when not known for five minutes (or `fresh`). Session text is never logged. */
  const known = async (repoId: string, fresh: boolean): Promise<Known> => {
    const k = material.get(repoId);
    if (k && !fresh && d.now() - k.at < MATERIAL_MS) return k;
    let next: Known;
    try {
      const m = pickMaterial(
        await d.sessionsOf(repoId),
        d.store.repo(repoId).covered,
      );
      const marks = Object.values(m.marks);
      next = {
        at: d.now(),
        hasMaterial: m.tasks.length > 0,
        newestMaterialAt: marks.length ? Math.max(...marks) : null,
        sessions: m.tasks.reduce((n, t) => n + t.sessions.length, 0),
      };
    } catch {
      console.error('[dreams] the sessions of a repo could not be read');
      next = {
        at: d.now(),
        hasMaterial: false,
        newestMaterialAt: null,
        sessions: 0,
      };
    }
    material.set(repoId, next);
    return next;
  };

  const repoEntry = (id: string, k: Known): ReadyInput['repos'][number] => ({
    id,
    state: d.store.repo(id),
    hasMaterial: k.hasMaterial,
    newestMaterialAt: k.newestMaterialAt,
  });

  /** The facts, cheapest first; a repo's sessions only once nothing else stands in the way. */
  const decide = async (manual?: {
    repoId: string;
  }): Promise<{ repoId: string } | { wait: Wait }> => {
    // A stored switch-off always wins, also across a restart: nothing starts (Dream now included), and settings
    // that still say on are saved off again on every check. Only `switchOn` ends it.
    if (offUnrecorded || d.store.switchedOff()) {
      if (d.settings.get().dreaming.enabled) await switchOff();
      return { wait: 'off' };
    }
    const s = d.settings.get().dreaming;
    // The list as known, without asking: a known list without the model says so first (the order of `nextDream`);
    // an unknown one is asked for only once the cheap checks pass, so OpenCode is not started while the owner works.
    const listedNow = d.models.known();
    const base: ReadyInput = {
      settings: s,
      models: listedNow ?? (s.model === null ? null : [s.model]),
      idleSeconds: d.idleSeconds(),
      onBattery: d.onBattery(),
      agentWorking: d.agentWorking(),
      running: dream !== null || d.runner.running() !== null,
      overLimit: false,
      now: d.now(),
      repos: [],
    };
    const cheap = nextDream(base, manual);
    if ('wait' in cheap && cheap.wait !== 'nothing-ready') return cheap;
    // At most every 10 minutes, a failed ask kept as long.
    base.models = await d.models.get();
    const listed = nextDream(base, manual);
    if ('wait' in listed && listed.wait !== 'nothing-ready') return listed;
    base.overLimit = !hasRoom();
    if (base.overLimit) return { wait: 'limit' };
    const candidates = d.repos().filter((r) => {
      const cfg = s.repos[r.id];
      return (
        cfg?.on &&
        cfg.folders.length > 0 &&
        (!manual || r.id === manual.repoId) &&
        d.store.repo(r.id).result === null
      );
    });
    for (const r of candidates)
      base.repos.push(repoEntry(r.id, await known(r.id, Boolean(manual))));
    return nextDream(base, manual);
  };

  const finished = async (
    repoId: string,
    model: string,
    startedAt: number,
    out: Awaited<ReturnType<DreamRunner['dream']>>,
  ) => {
    // The journal line the runner wrote for this dream, when it wrote one: newest first, at or after the start.
    const entry =
      d.store
        .journal()
        .find((e) => e.repoId === repoId && Date.parse(e.at) >= startedAt) ??
      null;
    sendSafely(d.event, 'dream.run', runProps(out, entry, d.now() - startedAt));
    if (out.outcome !== 'wrong-model') return;
    sendSafely(d.event, 'dream.switched_off', { by: 'wrong-model' });
    // Recorded first: the record keeps dreaming off even when the settings cannot be saved (retried each check).
    const recorded = await d.store
      .setSwitchedOff({
        answered: out.answered.join(', '),
        chosen: model,
        repoId,
      })
      .then(
        () => true,
        (e: unknown) => {
          console.error('[dreams] the switch-off could not be recorded', e);
          return false;
        },
      );
    if (!recorded) offUnrecorded = true;
    if (!(await switchOff()) && !recorded)
      // A known gap: neither file could be written, so after a restart dreaming would be on again.
      console.error(
        '[dreams] the switch-off could be neither recorded nor saved; it holds until Shellie quits',
      );
  };

  /**
   * After another model answered: saves `enabled: false` and forgets the model's passed test, in one write, so
   * switching on again needs a new test. False (logged) when it could not; the next check tries again.
   */
  const switchOff = async (): Promise<boolean> => {
    try {
      // From the settings as they are when the write runs, never a snapshot taken before.
      await d.settings.updateDreaming((cur) => ({
        ...cur,
        enabled: false,
        testedModel: null,
      }));
      return true;
    } catch (e) {
      console.error('[dreams] could not switch dreaming off', e);
      return false;
    }
  };

  const start = (repoId: string): boolean => {
    const repo = d.repos().find((r) => r.id === repoId);
    const s = d.settings.get().dreaming;
    const cfg = s.repos[repoId];
    if (!repo || !cfg || s.model === null) return false;
    const model = s.model;
    const stop = new AbortController();
    const startedAt = d.now();
    const done = d.runner
      .dream(repo, { model, folders: cfg.folders, signal: stop.signal })
      .then((out) => finished(repoId, model, startedAt, out))
      .catch((e: unknown) =>
        console.error('[dreams] the dream did not settle', e),
      )
      .finally(() => {
        dream = null;
        material.clear();
        d.broadcast();
      });
    dream = { repoId, stop, done };
    wait = null;
    d.broadcast();
    return true;
  };

  const tick = async () => {
    if (stopped) return;
    const before = wait;
    const r = await decide();
    if ('wait' in r) wait = r.wait;
    else if (!start(r.repoId)) wait = 'nothing-ready';
    // The screens show why no dream starts: a new reason is news (`start` sends its own).
    if (wait !== null && wait !== before) d.broadcast();
  };

  // ── sweep ──

  /** The dream folders of a known repo but the open result's, with git; returns the names of the folders found. */
  const sweepFolders = async (
    repo: Repo,
    config: string[],
  ): Promise<string[]> => {
    const keep = d.store.repo(repo.id).result?.id;
    const repoDir = path.join(d.dreamsDir, repo.id);
    const entries = await fs.readdir(repoDir, { withFileTypes: true });
    const found: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name === keep) continue;
      found.push(e.name);
      const dir = path.join(repoDir, e.name);
      const failure = await removeDream(
        d.git,
        repo.path,
        { dir, worktree: path.join(dir, 'wt'), branch: null },
        config,
      );
      if (failure)
        console.error(
          '[dreams] sweep could not remove a dream folder',
          failure,
        );
    }
    return found;
  };

  /**
   * The branches of the dream folders found to remove: `dream/<YYYY-MM-DD>-<n>` of such a folder only (the runner
   * makes the folder before the branch and removes it last), never one checked out outside the dreams folder. A
   * `dream/` branch without its folder is the owner's (a dream opened as a task keeps its branch) and stays.
   */
  const sweepBranches = async (
    repo: Repo,
    config: string[],
    folders: string[],
  ) => {
    const c = config.flatMap((x) => ['-c', x]);
    const keep = d.store.repo(repo.id).result?.branch;
    const branches: string[] = [];
    for (const id of folders) {
      const b = `dream/${id}`;
      if (
        DREAM_BRANCH.test(b) &&
        b !== keep &&
        (await d.git.branchExists(repo.path, b))
      )
        branches.push(b);
    }
    if (branches.length === 0) return;
    const dreamsReal = await fs.realpath(d.dreamsDir).catch(() => d.dreamsDir);
    const inDreams = (p: string) =>
      isInside(d.dreamsDir, p) || isInside(dreamsReal, p);
    const elsewhere = new Set(
      (await d.git.worktreeList(repo.path))
        .filter((w) => w.branch !== null && !inDreams(w.path))
        .map((w) => w.branch),
    );
    for (const b of branches) {
      if (elsewhere.has(b)) continue;
      await d.git
        .run(repo.path, [...c, 'branch', '-D', b])
        .catch((e: unknown) =>
          console.error('[dreams] sweep could not delete a dream branch', e),
        );
    }
  };

  const sweep = async () => {
    await fs.mkdir(d.dreamsDir, { recursive: true });
    const hooks = await fs.mkdtemp(path.join(d.dreamsDir, SWEEP_PREFIX));
    try {
      const config = unattendedConfig(hooks);
      const repos = new Map(d.repos().map((r) => [r.id, r]));
      const onDisk = new Map<string, boolean>();
      for (const r of repos.values())
        onDisk.set(r.id, await pathExists(r.path));
      for (const e of await fs.readdir(d.dreamsDir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === path.basename(hooks)) continue;
        if (e.name.startsWith(SWEEP_PREFIX)) {
          await removeTree(path.join(d.dreamsDir, e.name)).catch(
            () => undefined,
          );
          continue;
        }
        // The setup test's folder: never a repo's; removed whole once no test can still be running in it.
        if (e.name.startsWith(DREAM_TEST_PREFIX)) {
          const at = path.join(d.dreamsDir, e.name);
          const st = await fs.stat(at).catch(() => null);
          if (st && Date.now() - st.mtimeMs > TEST_LEFT_MS)
            await removeTree(at).catch(() => undefined);
          continue;
        }
        const repo = repos.get(e.name);
        // A repo Shellie no longer knows: its whole folder goes, without git (there is no repo to run it in).
        if (!repo) {
          await removeTree(path.join(d.dreamsDir, e.name)).catch((x: unknown) =>
            console.error('[dreams] sweep could not remove a dream folder', x),
          );
          continue;
        }
        // A repo that is gone from disk is left as it is.
        if (!onDisk.get(repo.id)) continue;
        const found = await sweepFolders(repo, config).catch((x: unknown) => {
          console.error('[dreams] sweep', x);
          return [] as string[];
        });
        await sweepBranches(repo, config, found).catch((x: unknown) =>
          console.error('[dreams] sweep', x),
        );
      }
      // Stored state of a repo Shellie no longer knows (removed while dreams were not running): the journal keeps
      // its lines.
      for (const id of d.store.repoIds())
        if (!repos.has(id))
          await d.store
            .forgetRepo(id)
            .catch((x: unknown) => console.error('[dreams] sweep', x));
    } finally {
      await removeTree(hooks).catch(() => undefined);
    }
  };

  const timer = setInterval(() => {
    void serial(tick).catch((e: unknown) =>
      console.error('[dreams] check failed', e),
    );
  }, d.tick ?? DREAM_TICK_MS);

  const abort = (why: 'stopped' | 'suspend') => dream?.stop.abort(why);

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    },
    /** Dream now: skips the idle, power and busy checks and the back-off only. */
    dreamNow(repoId: string): Promise<{ wait: Wait } | { started: true }> {
      return serial(async () => {
        const r = await decide({ repoId });
        if ('wait' in r) return r;
        return start(r.repoId)
          ? { started: true as const }
          : { wait: 'nothing-ready' as const };
      });
    },
    /**
     * The only way a switch-off ends: the owner switches dreaming on (`dream:switchOn`). `save` writes `enabled: true`,
     * then the switch-off record is cleared, both in the serial chain, so no check runs in between. A save that throws
     * keeps the record; a record that cannot be cleared keeps the switch-off in force (the next check saves off
     * again). The caller broadcasts.
     */
    switchOn(save: () => Promise<void>): Promise<void> {
      return serial(async () => {
        await save();
        // The last check's wait (`off`) no longer holds; the next check says why a dream waits.
        wait = null;
        await d.store.setSwitchedOff(null);
        offUnrecorded = false;
      });
    },
    stopDream(): void {
      abort('stopped');
    },
    /**
     * Stops the dream running for `repoId` (its repo was removed), as Stop does; resolves once it ended, at most after
     * `ms`. At once when none runs for it.
     */
    stopDreamOf(repoId: string, ms: number): Promise<void> {
      const running = dream;
      if (!running || running.repoId !== repoId) return Promise.resolve();
      running.stop.abort('stopped');
      return settledWithin(running.done, ms);
    },
    suspend(): void {
      abort('suspend');
    },
    /** Stops the running dream as on suspend; resolves once it ended, at most after `ms`. Null when none runs. */
    quit(ms: number): Promise<void> | null {
      const running = dream;
      abort('suspend');
      return running && settledWithin(running.done, ms);
    },
    /** Removes dream folders and `dream/*` branches no open result refers to; once, at launch. */
    sweep(): Promise<void> {
      return serial(sweep);
    },
    /** A task changed (any repo), or an agent tab of a task of `repoId` reported: its sessions may hold new material. */
    materialChanged(repoId?: string): void {
      if (repoId === undefined) material.clear();
      else material.delete(repoId);
    },
    status(): DreamStatus {
      const s = d.settings.get().dreaming;
      const fresh = [...material.entries()].filter(
        ([id, k]) => id !== dream?.repoId && d.now() - k.at < MATERIAL_MS,
      );
      const pick = nextDream({
        settings: s,
        models: s.model === null ? [] : [s.model],
        idleSeconds: Infinity,
        onBattery: false,
        agentWorking: false,
        running: false,
        overLimit: false,
        now: d.now(),
        repos: fresh.map(([id, k]) => repoEntry(id, k)),
      });
      return {
        wait: dream ? null : wait,
        next:
          'repoId' in pick
            ? {
                repoId: pick.repoId,
                newSessions: material.get(pick.repoId)!.sessions,
              }
            : null,
        switchedOff: d.store.switchedOff(),
        running: d.runner.running(),
        newSessions: Object.fromEntries(
          [...material.entries()]
            .filter(([, k]) => d.now() - k.at < MATERIAL_MS)
            .map(([id, k]) => [id, k.sessions]),
        ),
      };
    },
  };
}

export type DreamScheduler = ReturnType<typeof startDreamScheduler>;
