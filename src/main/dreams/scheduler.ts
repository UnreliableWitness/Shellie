/**
 * When a dream starts (spec section 2): a check once a minute, the one dream at a time, Dream now, Stop, suspend and
 * quit, and the sweep at launch of what an earlier run left behind. The decision itself is `nextDream`; this module
 * gathers its facts, cheapest first: a repo's sessions are read only once every other check has passed, and kept
 * for five minutes or until the dream store or the tasks change.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { DreamSwitchedOff } from '../../shared/dreams';
import type { AppSettings } from '../../shared/usage';
import { pathExists, removeTree } from '../fsRetry';
import { withTimeout } from '../async';
import { isInside } from '../paths';
import type { GitClient } from '../services/GitClient';
import type { DreamRunner } from './DreamRunner';
import type { DreamStore } from './DreamStore';
import { removeDream, unattendedConfig } from './dreamGit';
import { settledWithin } from './dreamRun';
import { pickMaterial, type TaskSessions } from './material';
import { nextDream, type ReadyInput, type Wait } from './ready';

export const DREAM_TICK_MS = 60_000;
/** `opencode models` is asked again at most this often. */
const MODELS_MS = 10 * 60_000;
/** A hung `opencode models` is given up on after this. */
const MODELS_TIMEOUT_MS = 30_000;
/** How long a repo's material counts as known without reading its sessions again. */
const MATERIAL_MS = 5 * 60_000;
/** The empty hooks folders of a sweep, inside the dreams folder; one left by a crash goes in the next sweep. */
const SWEEP_PREFIX = '.sweep-';
/** The branch name a dream gets (`DreamRunner`): `dream/<YYYY-MM-DD>-<n>`. */
const DREAM_BRANCH = /^dream\/\d{4}-\d{2}-\d{2}-\d+$/;

type Repo = { id: string; name: string; path: string };

export type DreamSchedulerDeps = {
  /** Reads `dreaming`; writes `enabled: false` only, after a call answered by another model. */
  settings: {
    get(): AppSettings;
    save(next: AppSettings): Promise<unknown>;
  };
  store: DreamStore;
  runner: Pick<DreamRunner, 'dream' | 'running'>;
  /** OpenCode's model list; null when it is not known. */
  models: () => Promise<string[] | null>;
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
  tick?: number;
};

export type DreamStatus = {
  /** Why no dream starts; null while one runs or before the first check. */
  wait: Wait | null;
  /** The repo that dreams next as far as its material is known, with its count of sessions to read. */
  next: { repoId: string; newSessions: number } | null;
  switchedOff: DreamSwitchedOff | null;
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
  /** A wrong-model outcome whose `enabled: false` is not saved yet. */
  let offPending = false;
  let models: { at: number; list: string[] | null; failed: boolean } | null =
    null;
  // Decisions, Dream now and the sweep run one after another, never side by side.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => undefined);
    return p;
  };
  const unsubscribe = d.store.onChange(() => material.clear());

  /**
   * OpenCode's models, asked at most every 10 minutes and given up on after 30 s. A failed ask keeps the last good
   * list for one more interval; a second in a row gives none.
   */
  const modelList = async (): Promise<string[] | null> => {
    if (models && d.now() - models.at < MODELS_MS) return models.list;
    const asked = await withTimeout(
      d.models().catch(() => null),
      MODELS_TIMEOUT_MS,
      () => null,
    );
    const keep = asked === null && models?.list && !models.failed;
    models = keep
      ? { at: d.now(), list: models!.list, failed: true }
      : { at: d.now(), list: asked, failed: asked === null };
    return models.list;
  };

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
    if (offPending) await switchOff();
    // Dreaming switched itself off and that is not saved yet: nothing starts, Dream now included.
    if (offPending) return { wait: 'off' };
    const s = d.settings.get().dreaming;
    // A backstop: switching on clears it (`clearSwitchedOff`).
    if (s.enabled && d.store.switchedOff())
      await clearSwitchedOff().catch((e: unknown) =>
        console.error('[dreams] switchedOff', e),
      );
    if (d.store.switchedOff()) return { wait: 'off' };
    const base: ReadyInput = {
      settings: s,
      models: s.enabled ? await modelList() : null,
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
    out: Awaited<ReturnType<DreamRunner['dream']>>,
  ) => {
    if (out.outcome !== 'wrong-model') return;
    // Recorded first, so Home says why even when the settings cannot be saved; the save is retried each check.
    await d.store
      .setSwitchedOff({
        answered: out.answered.join(', '),
        chosen: model,
        repoId,
      })
      .catch((e: unknown) => console.error('[dreams] switchedOff', e));
    offPending = true;
    await switchOff();
  };

  /** Saves `enabled: false`; on failure `offPending` stays set and the next check tries again. */
  const switchOff = async () => {
    const cur = d.settings.get();
    try {
      await d.settings.save({
        ...cur,
        dreaming: { ...cur.dreaming, enabled: false },
      });
      offPending = false;
    } catch (e) {
      console.error('[dreams] could not switch dreaming off', e);
    }
  };

  const clearSwitchedOff = async () => {
    await d.store.setSwitchedOff(null);
    d.broadcast();
  };

  const start = (repoId: string): boolean => {
    const repo = d.repos().find((r) => r.id === repoId);
    const s = d.settings.get().dreaming;
    const cfg = s.repos[repoId];
    if (!repo || !cfg || s.model === null) return false;
    const model = s.model;
    const stop = new AbortController();
    const done = d.runner
      .dream(repo, { model, folders: cfg.folders, signal: stop.signal })
      .then((out) => finished(repoId, model, out))
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
    const r = await decide();
    if ('wait' in r) wait = r.wait;
    else if (!start(r.repoId)) wait = 'nothing-ready';
  };

  // ── sweep ──

  /**
   * The dream folders of one repo id but the open result's, with git when the repo is known; returns the names of
   * the folders it found to remove.
   */
  const sweepFolders = async (
    repoId: string,
    repo: Repo | undefined,
  ): Promise<string[]> => {
    const keep = d.store.repo(repoId).result?.id;
    const repoDir = path.join(d.dreamsDir, repoId);
    const entries = await fs.readdir(repoDir, { withFileTypes: true });
    const found: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name === keep) continue;
      found.push(e.name);
      const dir = path.join(repoDir, e.name);
      const failure = repo
        ? await removeDream(d.git, repo.path, {
            dir,
            worktree: path.join(dir, 'wt'),
            branch: null,
          })
        : await removeTree(dir).then(
            () => null,
            (x: unknown) => x,
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
        const repo = repos.get(e.name);
        // A repo that is gone from disk is left as it is.
        if (repo && !onDisk.get(repo.id)) continue;
        const found = await sweepFolders(e.name, repo).catch((x: unknown) => {
          console.error('[dreams] sweep', x);
          return [] as string[];
        });
        if (repo)
          await sweepBranches(repo, config, found).catch((x: unknown) =>
            console.error('[dreams] sweep', x),
          );
      }
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
    /** Dreaming was switched on: what switched it off before is forgotten at once. */
    clearSwitchedOff(): Promise<void> {
      return clearSwitchedOff();
    },
    stopDream(): void {
      abort('stopped');
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
    /** A task changed: its sessions may hold new material. */
    materialChanged(): void {
      material.clear();
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
      };
    },
  };
}

export type DreamScheduler = ReturnType<typeof startDreamScheduler>;
