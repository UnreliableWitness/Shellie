import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BrainOptionsSchema,
  BrainSchema,
  BrainWikiSchema,
  SourceTypeSchema,
  type AddSourceResult,
  type Brain,
  type BrainView,
  type RefreshResult,
  type SourceType,
} from '../../shared/brain';
import type { Events, Handlers } from '../../shared/ipc';
import type { TelemetryProps } from '../../shared/telemetry';
import type { Connection, Repo, Task } from '../../shared/types';
import { taskConnectionId } from '../../shared/workspaces';
import { listDocs, readAsset, readDoc } from '../docs/worktreeFiles';
import type { GitClient } from '../services/GitClient';
import type { Tracker } from '../trackers/Tracker';
import type { BrainJobRunner } from './jobs';
import type { BrainStore } from './BrainStore';
import type { createBrainTerminals } from './brainTerminal';
import { imagesBucket, pagesBucket, sizeBucket } from './brainTelemetry';
import { brainForTask } from './context';
import { withBrainGit } from './gitMutex';
import { brainHealth } from './health';
import { refreshMirror, type MirrorAuth } from './mirror';
import {
  applyTemplates,
  isBrainFolder,
  scaffoldBrain,
  templateDiff,
} from './scaffold';
import type { Rasterize } from './convert';
import { addSource, listSources } from './sources';
import { acquireLock, readState, releaseLock } from './state';
import { TEMPLATES_VERSION } from './templates';
import { rootGitItemPath, wikiPageUrl } from './wikiAccess';

export type BrainChannels =
  | 'brain:list'
  | 'brain:get'
  | 'brain:forTask'
  | 'brain:create'
  | 'brain:update'
  | 'brain:delete'
  | 'brain:pickFolder'
  | 'brain:wikis'
  | 'brain:wikiPages'
  | 'brain:addFiles'
  | 'brain:addText'
  | 'brain:refresh'
  | 'brain:run'
  | 'brain:resumeQueue'
  | 'brain:sources'
  | 'brain:files'
  | 'brain:read'
  | 'brain:asset'
  | 'brain:terminal'
  | 'brain:templateDiff'
  | 'brain:updateTemplates'
  | 'brain:openFolder';

export type BrainRunner = Pick<
  BrainJobRunner,
  'enqueue' | 'jobs' | 'running' | 'resume'
>;

export type BrainHandlerDeps = {
  brains: BrainStore;
  /** Converts pictures in formats Claude cannot view (createRasterizer); absent in tests. */
  rasterize?: Rasterize;
  git: GitClient;
  runner: BrainRunner;
  /** The brain's Claude terminal (main); absent in tests that do not open one. */
  terminals?: Pick<ReturnType<typeof createBrainTerminals>, 'open' | 'kill'>;
  mirrorAuth: (connectionId: string, gitUrl: string) => MirrorAuth;
  tracker: (connectionId: string) => Pick<Tracker, 'wikis' | 'wikiPages'>;
  connections: {
    get(id: string): Pick<Connection, 'organizationUrl' | 'project'>;
  };
  task: (taskId: string) => Task;
  repos: () => Pick<Repo, 'id' | 'connectionId'>[];
  ledgerToday: (brainId: string) => { tokens: number; costEur: number };
  broadcast: (event: 'brain:changed', payload: Events['brain:changed']) => void;
  pickFolder: () => Promise<string | null>;
  /** shell.openPath: resolves to an error message, empty on success. */
  openPath: (absPath: string) => Promise<string>;
  userData: string;
  /** Telemetry scrubs these from now on (a brain's name and path). */
  remember: (values: string[]) => void;
  event: (name: string, props?: TelemetryProps) => void;
  now?: () => Date;
};

const ROOT_FILES = new Set(['index.md', 'log.md', 'SCHEMA.md']);
const BUSY = 'A brain job is running; try again later';

/** What a skill run writes; committed after a job succeeds so Health does not count it as an outside edit. */
const JOB_OUTPUT = ['wiki', 'index.md', 'log.md', 'brain/state.json'];

/** The message of the commit a job start makes of edits done outside a job; not 'Brain:', so Health keeps them. */
export const OUTSIDE_EDIT_MESSAGE = 'Edited outside a capture';

/** The job output paths git can stage: on disk, or tracked (deleted since). An adopted brain may lack some. */
async function stageable(git: GitClient, brainDir: string): Promise<string[]> {
  const tracked = (await git.run(brainDir, ['ls-files', '--', ...JOB_OUTPUT]))
    .split('\n')
    .filter(Boolean);
  const out: string[] = [];
  for (const p of JOB_OUTPUT) {
    const onDisk = await fs.stat(path.join(brainDir, ...p.split('/'))).then(
      () => true,
      () => false,
    );
    if (onDisk || tracked.some((t) => t === p || t.startsWith(`${p}/`)))
      out.push(p);
  }
  return out;
}

/**
 * The runner's `commit` (and, with OUTSIDE_EDIT_MESSAGE, its `beforeJob`): stages the job's output paths and commits
 * them when anything changed, nothing else.
 */
export function commitJobOutput(
  git: GitClient,
  brainDir: string,
  message: string,
): Promise<void> {
  return withBrainGit(brainDir, async () => {
    const paths = await stageable(git, brainDir);
    if (!paths.length) return;
    await git.run(brainDir, ['add', '-A', '--', ...paths]);
    const status = await git.run(brainDir, [
      'status',
      '--porcelain',
      '--',
      ...paths,
    ]);
    if (status.trim())
      await git.run(brainDir, ['commit', '-q', '-m', message, '--', ...paths]);
  });
}

const isEmptyOrMissing = async (dir: string) =>
  fs.readdir(dir).then(
    (e) => e.length === 0,
    () => true,
  );

const FORMATS = new Set(['pdf', 'docx', 'pptx', 'vtt', 'drawio', 'md', 'txt']);
/** The format a source arrived in, for telemetry: a known extension, else `other` (never what the user typed). */
const formatOf = (file: string) => {
  const ext = path.extname(file).slice(1).toLowerCase();
  return FORMATS.has(ext) ? ext : 'other';
};

export function createBrainHandlers(
  d: BrainHandlerDeps,
): Pick<Handlers, BrainChannels> {
  const now = d.now ?? (() => new Date());
  const changed = (brainId: string) =>
    d.broadcast('brain:changed', { brainId });
  const brainOf = (id: string): Brain => {
    const b = d.brains.get(id);
    if (!b) throw new Error(`Unknown brain ${id}`);
    return b;
  };
  /** A connection that was removed has no project. */
  const connectionProject = (id: string): string | null => {
    try {
      return d.connections.get(id).project;
    } catch {
      return null;
    }
  };
  /** Health costs git calls, a ledger scan and reading every source: only for `brain:get`. */
  const view = async (b: Brain, withHealth = false): Promise<BrainView> => {
    const jobs = d.runner.jobs(b.id);
    const paused = jobs.some((j) => j.status === 'paused');
    return {
      ...b,
      health: withHealth
        ? await brainHealth(b.path, d.git, d.ledgerToday(b.id), paused)
        : null,
      jobs,
    };
  };
  const sourceAdded = (
    type: SourceType,
    format: string,
    bytes: number,
    r: AddSourceResult,
  ) =>
    d.event('brain.source.added', {
      type,
      format,
      sizeKb: sizeBucket(bytes),
      outcome: r.ok ? 'ok' : r.reason,
      images: imagesBucket(r.ok ? r.images : 0),
    });

  const mirror = async (b: Brain): Promise<RefreshResult> => {
    const wiki = b.wiki;
    if (!wiki) return { ok: false, message: 'This brain has no wiki' };
    try {
      const root = await rootGitItemPath(wiki, () =>
        d.tracker(b.connectionId).wikiPages(b.project, wiki.wikiId),
      );
      if (!root.ok) return root;
      const org = d.connections.get(b.connectionId).organizationUrl;
      return await refreshMirror(
        d.git,
        b.path,
        wiki,
        root.path,
        d.mirrorAuth(b.connectionId, wiki.gitUrl),
        (gitItemPath) => wikiPageUrl(org, b.project, wiki, gitItemPath),
        now,
      );
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  };
  // One refresh per brain at a time (the button and the scheduler share it).
  const refreshing = new Map<string, Promise<RefreshResult>>();
  const refresh = async (id: string): Promise<RefreshResult> => {
    const b = brainOf(id);
    // The mirror commits in the brain folder: never while a job runs there (the runner retries its lock).
    let locked: boolean;
    try {
      locked = await acquireLock(b.path);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    if (!locked) return { ok: false, message: BUSY };
    const started = Date.now();
    let r: RefreshResult;
    try {
      r = await mirror(b);
    } finally {
      await releaseLock(b.path).catch(() => undefined);
    }
    d.event('brain.refresh', {
      outcome: r.ok ? 'ok' : 'failed',
      pages: pagesBucket(r.ok ? r.pages : 0),
      ms: Date.now() - started,
    });
    if (r.ok) {
      await d.brains.patch(id, { lastRefreshAt: now().toISOString() });
      if (b.options.syncAfterRefresh && r.added + r.changed + r.removed > 0)
        d.runner.enqueue(id, 'sync');
    }
    changed(id);
    return r;
  };

  return {
    'brain:list': async () => Promise.all(d.brains.list().map((b) => view(b))),
    'brain:get': async (id) => view(brainOf(id), true),
    'brain:forTask': async (taskId) => {
      const task = d.task(taskId);
      // A task without a work item gets no brain.
      if (!task.workItem) return null;
      const connectionId = taskConnectionId(task, d.repos());
      if (!connectionId) return null;
      // The work item's own project; the connection's for refs from before it was stored.
      const project = task.workItem.project ?? connectionProject(connectionId);
      const b = brainForTask(d.brains, connectionId, project);
      return b ? view(b) : null;
    },
    'brain:create': async (input) => {
      const name = input.name.trim();
      if (!name) throw new Error('A brain needs a name');
      const id = randomUUID();
      const dir = input.path ?? path.join(d.userData, 'brains', id);
      let templatesVersion = TEMPLATES_VERSION;
      if (input.path && (await isBrainFolder(dir))) templatesVersion = 0;
      else if (!(await isEmptyOrMissing(dir)))
        throw new Error('Folder is not empty and not a brain');
      else await scaffoldBrain(d.git, dir, name);
      const brain = BrainSchema.parse({
        id,
        name,
        connectionId: input.connectionId,
        project: input.project,
        path: dir,
        wiki: BrainWikiSchema.nullable().parse(input.wiki),
        templatesVersion,
        createdAt: now().toISOString(),
      });
      await d.brains.add(brain);
      d.remember([name, dir]);
      d.event('brain.created', { wiki: brain.wiki !== null });
      changed(id);
      return view(brain);
    },
    'brain:update': async (id, patch) => {
      const b = brainOf(id);
      const name = patch.name?.trim();
      if (patch.name !== undefined && !name)
        throw new Error('A brain needs a name');
      const wikiChanged = patch.wiki !== undefined;
      const updated = await d.brains.patch(id, {
        ...(name ? { name } : {}),
        ...(wikiChanged
          ? {
              wiki: BrainWikiSchema.nullable().parse(patch.wiki),
              lastRefreshAt: null,
            }
          : {}),
        ...(patch.options
          ? {
              options: BrainOptionsSchema.parse({
                ...b.options,
                ...patch.options,
              }),
            }
          : {}),
      });
      if (name) d.remember([name]);
      changed(id);
      return view(updated);
    },
    'brain:delete': async (id, deleteFolder) => {
      const b = brainOf(id);
      if (
        deleteFolder &&
        !(await isEmptyOrMissing(b.path)) &&
        !(await isBrainFolder(b.path))
      )
        throw new Error('The folder is not a brain; it was not deleted');
      if (b.terminal) await d.terminals?.kill(b.terminal.id);
      // Queued jobs of the brain stay in the runner; they fail on the missing folder or brain.
      await d.brains.remove(id);
      if (deleteFolder) await fs.rm(b.path, { recursive: true, force: true });
      d.event('brain.deleted', { folder: deleteFolder });
      changed(id);
    },
    'brain:pickFolder': () => d.pickFolder(),
    'brain:wikis': (connectionId, project) =>
      d.tracker(connectionId).wikis(project),
    'brain:wikiPages': (connectionId, project, wikiId) =>
      d.tracker(connectionId).wikiPages(project, wikiId),
    'brain:addFiles': async (id, files) => {
      const b = brainOf(id);
      const out: AddSourceResult[] = [];
      for (const f of files) {
        const type = SourceTypeSchema.parse(f.type);
        const r = await addSource(
          d.git,
          b.path,
          { file: f.path },
          type,
          undefined,
          { rasterize: d.rasterize },
        );
        const bytes = await fs.stat(f.path).then(
          (s) => s.size,
          () => 0,
        );
        sourceAdded(type, formatOf(f.path), bytes, r);
        if (r.ok) d.runner.enqueue(id, 'capture', r.path);
        out.push(r);
      }
      changed(id);
      return out;
    },
    'brain:addText': async (id, text, title, type) => {
      const b = brainOf(id);
      const t = SourceTypeSchema.parse(type);
      const r = await addSource(d.git, b.path, { text, title }, t);
      sourceAdded(t, 'text', Buffer.byteLength(text), r);
      if (r.ok) d.runner.enqueue(id, 'capture', r.path);
      changed(id);
      return r;
    },
    'brain:refresh': (id) => {
      const pending = refreshing.get(id);
      if (pending) return pending;
      const p = refresh(id).finally(() => refreshing.delete(id));
      refreshing.set(id, p);
      return p;
    },
    'brain:run': async (id, kind, source) => {
      brainOf(id);
      return d.runner.enqueue(id, kind, source ?? null);
    },
    'brain:resumeQueue': async (id) => {
      brainOf(id);
      d.runner.resume(id);
    },
    'brain:sources': async (id) => {
      const b = brainOf(id);
      return listSources(b.path, (await readState(b.path)).state);
    },
    'brain:files': async (id, dir) => {
      const b = brainOf(id);
      const keep =
        dir === 'root'
          ? (p: string) => ROOT_FILES.has(p)
          : dir === 'wiki' || dir === 'sources'
            ? (p: string) => p.startsWith(`${dir}/`)
            : null;
      if (!keep) throw new Error(`Unknown folder ${String(dir)}`);
      return (await listDocs(d.git, b.path, null)).filter((f) => keep(f.path));
    },
    'brain:read': async (id, rel) => ({
      text: (await readDoc(brainOf(id).path, rel)).text,
    }),
    'brain:asset': async (id, rel) => readAsset(brainOf(id).path, rel),
    'brain:terminal': async (id, resumeSession, prompt) => {
      brainOf(id);
      if (!d.terminals) throw new Error('Brain terminals are not available');
      return d.terminals.open(id, resumeSession, prompt);
    },
    'brain:templateDiff': async (id) => {
      const b = brainOf(id);
      return templateDiff(b.path, b.name);
    },
    'brain:updateTemplates': async (id, paths) => {
      const b = brainOf(id);
      await applyTemplates(d.git, b.path, b.name, paths);
      await d.brains.patch(id, { templatesVersion: TEMPLATES_VERSION });
      changed(id);
    },
    'brain:openFolder': async (id) => {
      const error = await d.openPath(brainOf(id).path);
      if (error) throw new Error(`Could not open the folder: ${error}`);
    },
  };
}
