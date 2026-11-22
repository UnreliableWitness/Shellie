/**
 * When a dream starts (spec section 2): a check once a minute, the one dream at a time, Dream now, Stop, suspend and
 * quit, and the sweep at launch of what an earlier run left behind. The decision itself is `nextDream`; this module
 * gathers its facts, cheapest first: a repo's sessions are read only once every other check has passed, and kept
 * until something that can change them happens (at most an hour).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  dreamingOf,
  projectsOnModel,
  type DreamingAll,
  type DreamSwitchedOff,
} from '../../shared/dreams';
import type { AppSettings } from '../../shared/usage';
import { pathExists, removeTree } from '../fsRetry';
import { isInside } from '../paths';
import { configFlags, type GitClient } from '../services/GitClient';
import type { DreamRunner } from './DreamRunner';
import type { DreamStore } from './DreamStore';
import { DREAM_TEST_PREFIX, removeDream, unattendedConfig } from './dreamGit';
import { settledWithin } from './dreamRun';
import type { OpencodeModelList } from './models';
import { runProps, sendSafely, type DreamEvent } from './dreamTelemetry';
import { pickMaterial, sessionCount, type TaskSessions } from './material';
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

/** `connectionId` is the repo's project; a repo without one does not dream. */
type Repo = {
  id: string;
  name: string;
  path: string;
  connectionId: string | null;
};

export type DreamSchedulerDeps = {
  /** Reads `dreaming`; writes only `enabled: false` and `testedModel: null`, after a call answered by another model. */
  settings: {
    get(): AppSettings;
    updateDreaming(fn: (current: DreamingAll) => DreamingAll): Promise<unknown>;
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
  /** Whether the project (its connection id) has room under its own daily limit. */
  limit: { hasRoom(project: string): boolean };
  /** Sends `dream:changed`. */
  broadcast: () => void;
  now: () => number;
  git: Pick<
    GitClient,
    'run' | 'branchExists' | 'worktreeRemove' | 'worktreePrune' | 'worktreeList'
  >;
  /** The dreams folder: every dream's worktree, data and hooks lie in it. */
  dreamsDir: string;
  /** `dream.run` and `dream.switched_off` (`docs/telemetry.md`); none when absent. */
  event?: DreamEvent;
  tick?: number;
};

/** What one project's screens show. Nothing of another project's dreams is in it but that one runs. */
export type DreamStatus = {
  /** Why no dream of the project starts; null while one of its own runs or before the first check. */
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
  /** Why no dream starts, per project (connection id), as of the last check. */
  const waits = new Map<string, Wait>();
  let dream: {
    repoId: string;
    project: string;
    stop: AbortController;
    done: Promise<void>;
  } | null = null;
  const material = new Map<string, Known>();
  /** The projects whose wrong-model switch-off the dream store could not record: it holds for this session. */
  const offUnrecorded = new Set<string>();
  // Decisions, Dream now and the sweep run one after another, never side by side.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => undefined);
    return p;
  };
  const unsubscribe = d.store.onChange(() => material.clear());

  const hasRoom = (project: string): boolean => {
    try {
      return d.limit.hasRoom(project);
    } catch {
      // A usage that cannot be read leaves no room.
      return false;
    }
  };

  /** The repo's material, read again when not known for an hour (or `fresh`). Session text is never logged. */
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
        sessions: sessionCount(m),
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

  const all = (): DreamingAll => d.settings.get().dreaming;
  const projectOf = (repoId: string): string | null =>
    d.repos().find((r) => r.id === repoId)?.connectionId ?? null;

  /** One project's facts, cheapest first; a repo's sessions only once nothing else stands in the way. */
  const decideFor = async (
    project: string,
    manual?: { repoId: string },
  ): Promise<{ repoId: string } | { wait: Wait }> => {
    // A stored switch-off always wins, also across a restart: nothing starts (Dream now included), and settings
    // that still say on are saved off again on every check. Only `switchOn` ends it.
    if (offUnrecorded.has(project) || d.store.switchedOff(project)) {
      if (dreamingOf(all(), project).enabled) await switchOff([project]);
      return { wait: 'off' };
    }
    const s = dreamingOf(all(), project);
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
    base.overLimit = !hasRoom(project);
    if (base.overLimit) return { wait: 'limit' };
    // Only the project's own repos: one moved to another project no longer dreams for this one.
    const candidates = d.repos().filter((r) => {
      const cfg = s.repos[r.id];
      return (
        r.connectionId === project &&
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

  /** When the project last dreamt (any of its repos); never is the oldest. */
  const lastDreamOf = (project: string): number =>
    d
      .repos()
      .filter((r) => r.connectionId === project)
      .reduce((latest, r) => {
        const at = d.store.repo(r.id).lastDreamAt;
        return at === null ? latest : Math.max(latest, Date.parse(at) || 0);
      }, -Infinity);

  const finished = async (
    repoId: string,
    project: string,
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
    await serial(() =>
      switchOffModel({
        project,
        model,
        answered: out.answered.join(', '),
        repoId,
      }),
    );
  };

  /**
   * Another model answered a call of `project` on `model` (a dream, or the setup's re-test with `repoId` ''): the
   * fault is the model's, so every project that dreams on it stops, each with its own record. Run in the serial chain.
   */
  const switchOffModel = async (off: {
    project: string;
    model: string;
    answered: string;
    repoId: string;
  }) => {
    const affected = [
      ...new Set([off.project, ...projectsOnModel(all(), off.model)]),
    ];
    // The event means a project's dreaming went from on to off: a re-test can find every affected project already off.
    if (affected.some((p) => dreamingOf(all(), p).enabled))
      sendSafely(d.event, 'dream.switched_off', { by: 'wrong-model' });
    // Recorded first: the record keeps dreaming off even when the settings cannot be saved (retried each check).
    let unrecorded = false;
    for (const p of affected) {
      const recorded = await d.store
        .setSwitchedOff(p, {
          answered: off.answered,
          chosen: off.model,
          repoId: off.repoId,
        })
        .then(
          () => true,
          (e: unknown) => {
            console.error('[dreams] the switch-off could not be recorded', e);
            return false;
          },
        );
      if (!recorded) {
        offUnrecorded.add(p);
        unrecorded = true;
      }
    }
    if (!(await switchOff(affected)) && unrecorded)
      // A known gap: neither file could be written, so after a restart dreaming would be on again.
      console.error(
        '[dreams] the switch-off could be neither recorded nor saved; it holds until Shellie quits',
      );
    for (const p of affected) if (dream?.project === p) abort('stopped');
  };

  /**
   * After another model answered: saves `enabled: false` and forgets the model's passed test for each of the
   * projects, in one write, so switching on again needs a new test. False (logged) when it could not; the next
   * check tries again.
   */
  const switchOff = async (projects: string[]): Promise<boolean> => {
    try {
      // From the settings as they are when the write runs, never a snapshot taken before.
      await d.settings.updateDreaming((cur) => {
        const next = { ...cur, projects: { ...cur.projects } };
        for (const p of projects)
          if (next.projects[p])
            next.projects[p] = {
              ...next.projects[p],
              enabled: false,
              testedModel: null,
            };
        return next;
      });
      return true;
    } catch (e) {
      console.error('[dreams] could not switch dreaming off', e);
      return false;
    }
  };

  const start = (repoId: string): boolean => {
    const repo = d.repos().find((r) => r.id === repoId);
    const project = repo?.connectionId ?? null;
    if (!repo || project === null) return false;
    const s = dreamingOf(all(), project);
    const cfg = s.repos[repoId];
    // Checked again here: a switch-off may have landed while the check was reading sessions or asking for models.
    if (
      !s.enabled ||
      offUnrecorded.has(project) ||
      d.store.switchedOff(project)
    )
      return false;
    if (!cfg || s.model === null) return false;
    const model = s.model;
    const stop = new AbortController();
    const startedAt = d.now();
    const done = d.runner
      .dream(repo, {
        model,
        folders: cfg.folders,
        signal: stop.signal,
        project,
      })
      .then((out) => finished(repoId, project, model, startedAt, out))
      .catch((e: unknown) =>
        console.error('[dreams] the dream did not settle', e),
      )
      .finally(() => {
        dream = null;
        material.clear();
        d.broadcast();
      });
    dream = { repoId, project, stop, done };
    waits.delete(project);
    d.broadcast();
    return true;
  };

  /** Every project with a setup, and every one that switched itself off (its settings may still say on). */
  const projects = (): string[] => [
    ...new Set([
      ...Object.keys(all().projects),
      ...d.store.switchedOffProjects(),
      ...offUnrecorded,
    ]),
  ];

  const tick = async () => {
    if (stopped) return;
    const before = new Map(waits);
    const now = projects();
    for (const p of waits.keys()) if (!now.includes(p)) waits.delete(p);
    const ready: { project: string; repoId: string }[] = [];
    for (const p of now) {
      const r = await decideFor(p);
      if ('wait' in r) waits.set(p, r.wait);
      else ready.push({ project: p, repoId: r.repoId });
    }
    // One dream at a time: the project that dreamt longest ago goes, the others wait for the next check.
    ready.sort(
      (a, b) =>
        lastDreamOf(a.project) - lastDreamOf(b.project) ||
        (a.project < b.project ? -1 : 1),
    );
    let started = false;
    for (const r of ready) {
      if (!started && start(r.repoId)) started = true;
      else waits.set(r.project, started ? 'running' : 'nothing-ready');
    }
    // The screens show why no dream starts: a new reason is news (`start` sends its own).
    const changed =
      waits.size !== before.size ||
      [...waits].some(([p, w]) => before.get(p) !== w);
    if (changed && !started) d.broadcast();
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
    const c = configFlags(config);
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
    /** Dream now, for the repo's project: skips the idle, power and busy checks and the back-off only. */
    dreamNow(repoId: string): Promise<{ wait: Wait } | { started: true }> {
      return serial(async () => {
        const project = projectOf(repoId);
        // A repo Shellie does not know, or one without a project: nothing of it can dream.
        if (project === null) return { wait: 'nothing-ready' as const };
        const r = await decideFor(project, { repoId });
        if ('wait' in r) return r;
        return start(r.repoId)
          ? { started: true as const }
          : { wait: 'nothing-ready' as const };
      });
    },
    /**
     * The only way a project's switch-off ends: the owner switches its dreaming on (`dream:switchOn`). `save` writes
     * `enabled: true`, then the switch-off record is cleared, both in the serial chain, so no check runs in between.
     * A save that throws keeps the record; a record that cannot be cleared keeps the switch-off in force (the next
     * check saves off again). The caller broadcasts.
     */
    switchOn(project: string, save: () => Promise<void>): Promise<void> {
      return serial(async () => {
        await save();
        // The last check's wait (`off`) no longer holds; the next check says why a dream waits.
        waits.delete(project);
        await d.store.setSwitchedOff(project, null);
        offUnrecorded.delete(project);
      });
    },
    /**
     * Another model answered a call on `model` (the setup's re-test): as after such a dream, every project on the
     * model is recorded and saved off, its passed test forgotten, and its running dream stops. The caller broadcasts.
     */
    switchOffModel(off: {
      project: string;
      model: string;
      answered: string;
      repoId: string;
    }): Promise<void> {
      return serial(() => switchOffModel(off));
    },
    /** The dream that runs now, with the project it was started for; null when none does. */
    runningDream(): { repoId: string; project: string } | null {
      return dream && { repoId: dream.repoId, project: dream.project };
    },
    /** Stop: the running dream, when it is the project's. */
    stopDream(project: string): void {
      if (dream?.project === project) abort('stopped');
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
    status(project: string): DreamStatus {
      const s = dreamingOf(all(), project);
      const own = new Set(
        d
          .repos()
          .filter((r) => r.connectionId === project)
          .map((r) => r.id),
      );
      const fresh = [...material.entries()].filter(
        ([id, k]) => own.has(id) && d.now() - k.at < MATERIAL_MS,
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
        repos: fresh
          .filter(([id]) => id !== dream?.repoId)
          .map(([id, k]) => repoEntry(id, k)),
      });
      const running = d.runner.running();
      return {
        wait: dream
          ? dream.project === project
            ? null
            : 'running-elsewhere'
          : (waits.get(project) ?? null),
        next:
          'repoId' in pick
            ? {
                repoId: pick.repoId,
                newSessions: material.get(pick.repoId)!.sessions,
              }
            : null,
        switchedOff: d.store.switchedOff(project),
        // The scheduler's own record: a dream stays the project's it started for, wherever its repo is linked now.
        running: running && dream?.project === project ? running : null,
        newSessions: Object.fromEntries(
          fresh.map(([id, k]) => [id, k.sessions]),
        ),
      };
    },
  };
}

export type DreamScheduler = ReturnType<typeof startDreamScheduler>;
