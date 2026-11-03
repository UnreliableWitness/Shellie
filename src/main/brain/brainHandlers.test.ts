import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdoWikiPage,
  BrainJob,
  BrainJobKind,
  BrainWiki,
} from '../../shared/brain';
import type { Repo, Task } from '../../shared/types';
import { GitClient } from '../services/GitClient';
import {
  cleanupTempRepos,
  commitFile,
  git as sh,
  makeRepo,
} from '../test-helpers/gitRepo';
import { BrainStore } from './BrainStore';
import { createBrainHandlers, type BrainHandlerDeps } from './brainHandlers';
import { isBrainFolder, scaffoldBrain } from './scaffold';
import { TEMPLATES_VERSION } from './templates';

const NEW = {
  name: 'Acme',
  connectionId: 'c1',
  project: 'Acme',
  path: null,
  wiki: null,
};

describe('brain handlers', () => {
  const git = new GitClient();
  let userData: string;
  let brains: BrainStore;
  let broadcasts: [string, unknown][];
  let events: [string, unknown][];
  let remembered: string[];
  let enqueued: [string, BrainJobKind, string | null][];
  let killed: string[];
  let opened: string[];
  let pages: AdoWikiPage[];
  let tasks: Task[];
  let h: ReturnType<typeof createBrainHandlers>;

  const job = (brainId: string, kind: BrainJobKind, source: string | null) =>
    ({
      id: `j${enqueued.length}`,
      brainId,
      kind,
      source,
      status: 'queued',
      startedAt: null,
      endedAt: null,
      sessionId: null,
      result: null,
      error: null,
    }) satisfies BrainJob;

  beforeEach(async () => {
    userData = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-brainh-')),
    );
    brains = new BrainStore(path.join(userData, 'brains.json'));
    await brains.load();
    broadcasts = [];
    events = [];
    remembered = [];
    enqueued = [];
    killed = [];
    opened = [];
    pages = [];
    tasks = [];
    const deps: BrainHandlerDeps = {
      brains,
      git,
      runner: {
        enqueue: (id, kind, source = null) => {
          enqueued.push([id, kind, source]);
          return job(id, kind, source);
        },
        jobs: () => [],
        running: () => false,
        resume: vi.fn(),
      },
      terminals: {
        open: async (id) => {
          opened.push(id);
          return { id: 't', kind: 'claude' as const, label: 'x' };
        },
        kill: async (id) => {
          killed.push(id);
          return true;
        },
      },
      mirrorAuth: () => async () => ({}),
      tracker: () => ({
        wikis: async () => [],
        wikiPages: async () => pages,
      }),
      connections: {
        get: () =>
          ({
            id: 'c1',
            organizationUrl: 'https://dev.azure.com/org/',
            project: 'Default',
          }) as ReturnType<BrainHandlerDeps['connections']['get']>,
      },
      task: (id) => {
        const t = tasks.find((x) => x.id === id);
        if (!t) throw new Error(`Unknown task ${id}`);
        return t;
      },
      repos: () => [{ id: 'r1', connectionId: 'c1' } as Repo],
      ledgerToday: () => ({ tokens: 0, costEur: 0 }),
      broadcast: (e, p) => broadcasts.push([e, p]),
      pickFolder: async () => '/picked',
      openPath: async () => '',
      userData,
      remember: (v) => remembered.push(...v),
      event: (n, p) => events.push([n, p]),
    };
    h = createBrainHandlers(deps);
  });
  afterEach(async () => {
    cleanupTempRepos();
    await fs.rm(userData, { recursive: true, force: true });
  });

  it('create scaffolds a brain under userData and lists it', async () => {
    const v = await h['brain:create'](NEW);
    expect(v.path).toBe(path.join(userData, 'brains', v.id));
    expect(await isBrainFolder(v.path)).toBe(true);
    expect(v.templatesVersion).toBe(TEMPLATES_VERSION);
    expect(v.health.outsideEdits).toEqual([]);
    expect(v.jobs).toEqual([]);
    expect((await h['brain:list']()).map((b) => b.id)).toEqual([v.id]);
    expect(broadcasts.at(-1)).toEqual(['brain:changed', { brainId: v.id }]);
    expect(events).toContainEqual(['brain.created', { wiki: false }]);
    expect(remembered).toEqual(expect.arrayContaining(['Acme', v.path]));
  });

  it('create adopts an existing brain folder and refuses a non-empty other folder', async () => {
    const existing = path.join(userData, 'mine');
    await scaffoldBrain(git, existing, 'Old name');
    const v = await h['brain:create']({ ...NEW, path: existing });
    expect(v.path).toBe(existing);
    expect(v.templatesVersion).toBe(0);
    const other = path.join(userData, 'other');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'x.txt'), 'x');
    await expect(h['brain:create']({ ...NEW, path: other })).rejects.toThrow(
      'Folder is not empty and not a brain',
    );
    const empty = path.join(userData, 'empty');
    await fs.mkdir(empty);
    const e = await h['brain:create']({ ...NEW, path: empty });
    expect(await isBrainFolder(e.path)).toBe(true);
  });

  it('addText writes a source and enqueues a capture', async () => {
    const v = await h['brain:create'](NEW);
    broadcasts = [];
    const r = await h['brain:addText'](
      v.id,
      'Kick-off notes',
      'Kick-off',
      'note',
    );
    expect(r.ok).toBe(true);
    expect(enqueued).toHaveLength(1);
    const [id, kind, source] = enqueued[0];
    expect([id, kind]).toEqual([v.id, 'capture']);
    expect(source).toMatch(/^sources\/.+\.md$/);
    expect(source).toBe(r.ok ? r.path : null);
    expect(broadcasts).toContainEqual(['brain:changed', { brainId: v.id }]);
    expect(events).toContainEqual([
      'brain.source.added',
      { type: 'note', format: 'text', sizeKb: '<10', outcome: 'ok' },
    ]);
  });

  it('addFiles reports unsupported files without enqueueing', async () => {
    const v = await h['brain:create'](NEW);
    const bad = path.join(userData, 'notes.xyz');
    const good = path.join(userData, 'notes.md');
    await fs.writeFile(bad, 'x');
    await fs.writeFile(good, '# Notes\n\nbody\n');
    const r = await h['brain:addFiles'](v.id, [
      { path: bad, type: 'doc' },
      { path: good, type: 'doc' },
    ]);
    expect(r[0]).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(r[1].ok).toBe(true);
    expect(enqueued.map((e) => e[1])).toEqual(['capture']);
    expect(events.filter((e) => e[0] === 'brain.source.added')).toEqual([
      [
        'brain.source.added',
        { type: 'doc', format: 'other', sizeKb: '<10', outcome: 'unsupported' },
      ],
      [
        'brain.source.added',
        { type: 'doc', format: 'md', sizeKb: '<10', outcome: 'ok' },
      ],
    ]);
  });

  it("forTask resolves by connection and the work item's project", async () => {
    const v = await h['brain:create'](NEW);
    tasks = [
      {
        id: 't1',
        connectionId: null,
        repoId: 'r1',
        workItem: { project: 'Acme' },
      },
      { id: 't2', connectionId: 'c1', repoId: 'r1', workItem: null },
      {
        id: 't3',
        connectionId: 'c2',
        repoId: 'r1',
        workItem: { project: 'Acme' },
      },
    ] as unknown as Task[];
    expect((await h['brain:forTask']('t1'))?.id).toBe(v.id);
    // No project on the work item: the connection's project (Default), which has no brain.
    expect(await h['brain:forTask']('t2')).toBeNull();
    expect(await h['brain:forTask']('t3')).toBeNull();
  });

  it('read refuses a path outside the brain and lists files', async () => {
    const v = await h['brain:create'](NEW);
    await expect(h['brain:read'](v.id, '../x')).rejects.toThrow();
    expect((await h['brain:read'](v.id, 'SCHEMA.md')).text).toContain('#');
    await fs.writeFile(path.join(v.path, 'wiki', 'account.md'), '# A\n');
    expect((await h['brain:files'](v.id, 'wiki')).map((f) => f.path)).toEqual([
      'wiki/account.md',
    ]);
    expect(
      (await h['brain:files'](v.id, 'root')).map((f) => f.path).sort(),
    ).toEqual(['SCHEMA.md', 'index.md', 'log.md']);
  });

  it('run queues a job and terminal opens the brain terminal', async () => {
    const v = await h['brain:create'](NEW);
    expect((await h['brain:run'](v.id, 'lint')).kind).toBe('lint');
    expect(enqueued).toEqual([[v.id, 'lint', null]]);
    expect((await h['brain:terminal'](v.id)).kind).toBe('claude');
    expect(opened).toEqual([v.id]);
    await expect(h['brain:run']('nope', 'lint')).rejects.toThrow(
      'Unknown brain',
    );
  });

  it('delete with deleteFolder removes the folder and kills the terminal', async () => {
    const v = await h['brain:create'](NEW);
    await brains.patch(v.id, {
      terminal: { id: 'brain-term', kind: 'claude', label: 'x' },
    });
    await h['brain:delete'](v.id, true);
    expect(killed).toEqual(['brain-term']);
    expect(brains.list()).toEqual([]);
    await expect(fs.stat(v.path)).rejects.toThrow();
    expect(broadcasts.at(-1)).toEqual(['brain:changed', { brainId: v.id }]);
    expect(events).toContainEqual(['brain.deleted', { folder: true }]);
  });

  it('delete without deleteFolder keeps the folder', async () => {
    const v = await h['brain:create'](NEW);
    await h['brain:delete'](v.id, false);
    expect(await isBrainFolder(v.path)).toBe(true);
    expect(brains.list()).toEqual([]);
  });

  it('update merges options and keeps the rest', async () => {
    const v = await h['brain:create'](NEW);
    const u = await h['brain:update'](v.id, {
      name: 'Acme NV',
      options: { weeklyDigest: true },
    });
    expect(u.name).toBe('Acme NV');
    expect(u.options.weeklyDigest).toBe(true);
    expect(u.options.dailyTokenCap).toBe(500_000);
    expect(remembered).toContain('Acme NV');
  });

  it('updateTemplates rewrites managed files and bumps the version', async () => {
    const existing = path.join(userData, 'mine');
    await scaffoldBrain(git, existing, 'Acme');
    const v = await h['brain:create']({ ...NEW, path: existing });
    await fs.writeFile(path.join(existing, 'SCHEMA.md'), 'edited');
    expect(
      (await h['brain:templateDiff'](v.id)).find((d) => d.path === 'SCHEMA.md')
        ?.status,
    ).toBe('changed');
    await h['brain:updateTemplates'](v.id, ['SCHEMA.md']);
    expect(
      (await h['brain:templateDiff'](v.id)).find((d) => d.path === 'SCHEMA.md')
        ?.status,
    ).toBe('same');
    expect(brains.get(v.id)?.templatesVersion).toBe(TEMPLATES_VERSION);
  });

  describe('refresh', () => {
    let wikiRepo: string;
    let wiki: BrainWiki;
    beforeEach(() => {
      wikiRepo = makeRepo('wiki');
      sh(wikiRepo, 'checkout', '-q', '-b', 'wikiMaster');
      sh(wikiRepo, 'config', 'core.quotepath', 'false');
      commitFile(wikiRepo, 'Home.md', '# Home\n');
      wiki = {
        wikiId: 'w1',
        wikiName: 'Acme.wiki',
        type: 'projectWiki',
        repositoryId: 'r',
        gitUrl: wikiRepo,
        version: 'wikiMaster',
        mappedPath: '/',
        rootPath: '/Home',
      };
      pages = [{ path: '/Home', gitItemPath: '/Home.md', isParent: false }];
    });

    it('mirrors the root page, stamps lastRefreshAt and enqueues a sync when asked', async () => {
      const v = await h['brain:create']({ ...NEW, wiki });
      await h['brain:update'](v.id, { options: { syncAfterRefresh: true } });
      const r = await h['brain:refresh'](v.id);
      expect(r).toMatchObject({ ok: true, added: 1, pages: 1 });
      expect(brains.get(v.id)?.lastRefreshAt).not.toBeNull();
      expect(enqueued).toEqual([[v.id, 'sync', null]]);
      const text = await fs.readFile(
        path.join(v.path, 'sources', 'wiki', 'Home.md'),
        'utf8',
      );
      expect(text).toContain(
        'https://dev.azure.com/org/Acme/_wiki/wikis/w1?pagePath=%2FHome',
      );
      expect(events.find((e) => e[0] === 'brain.refresh')?.[1]).toMatchObject({
        outcome: 'ok',
        pages: '1-10',
      });
      // Nothing changed: no second sync.
      await h['brain:refresh'](v.id);
      expect(enqueued).toHaveLength(1);
    });

    it('fails when the root page is gone', async () => {
      const v = await h['brain:create']({ ...NEW, wiki });
      pages = [];
      expect(await h['brain:refresh'](v.id)).toEqual({
        ok: false,
        message: 'Root page not found: /Home',
      });
      expect(brains.get(v.id)?.lastRefreshAt).toBeNull();
      expect(events.find((e) => e[0] === 'brain.refresh')?.[1]).toMatchObject({
        outcome: 'failed',
      });
    });

    it('fails without a wiki', async () => {
      const v = await h['brain:create'](NEW);
      expect(await h['brain:refresh'](v.id)).toMatchObject({ ok: false });
    });
  });
});
