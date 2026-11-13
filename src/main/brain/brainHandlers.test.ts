import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { updateConflicts } from './conflicts';
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
import {
  commitJobOutput,
  createBrainHandlers,
  OUTSIDE_EDIT_MESSAGE,
  refreshIndex,
  verifyPage,
  type BrainHandlerDeps,
} from './brainHandlers';
import { acquireLock, releaseLock } from './state';
import { brainHealth } from './health';
import { isBrainFolder, scaffoldBrain } from './scaffold';
import { TEMPLATES_VERSION } from './templates';

const NEW = {
  name: 'Acme',
  connectionId: 'c1',
  project: 'Acme',
  path: null,
  wiki: null,
  agent: 'claude' as const,
};

describe('brain handlers', () => {
  const git = new GitClient();
  let userData: string;
  let brains: BrainStore;
  let broadcasts: [string, unknown][];
  let events: [string, unknown][];
  let remembered: string[];
  let enqueued: [
    string,
    BrainJobKind,
    string | null,
    { background?: boolean; target?: string }?,
  ][];
  let pending: BrainJob[];
  let released: string[];
  let killed: string[];
  let opened: string[];
  let openArgs: [string | null | undefined, string | undefined][];
  let openAgents: (string | undefined)[];
  let pages: AdoWikiPage[];
  let tasks: Task[];
  let h: ReturnType<typeof createBrainHandlers>;
  let deps: BrainHandlerDeps;

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
      background: false,
      agent: 'claude',
      model: null,
      replays: 0,
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
    pending = [];
    released = [];
    killed = [];
    opened = [];
    openArgs = [];
    openAgents = [];
    pages = [];
    tasks = [];
    deps = {
      brains,
      git,
      runner: {
        enqueue: (id, kind, source = null, opts) => {
          enqueued.push(opts ? [id, kind, source, opts] : [id, kind, source]);
          return job(id, kind, source);
        },
        jobs: () => pending,
        running: () => false,
        resume: vi.fn(),
        dropQueued: () => 0,
        held: () => false,
        release: (id) => {
          released.push(id);
        },
      },
      terminals: {
        open: async (id, resume, prompt, agent) => {
          opened.push(id);
          openArgs.push([resume, prompt]);
          openAgents.push(agent);
          return { id: 't', kind: 'claude' as const, label: 'x' };
        },
        kill: async (id) => {
          killed.push(id);
          return true;
        },
      },
      home: {
        get: () => null,
        save: async () => {
          throw new Error('not here');
        },
        remove: async () => undefined,
        token: async () => {
          throw new Error('not here');
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
            user: null,
          }) as ReturnType<BrainHandlerDeps['connections']['get']>,
        list: () => [],
        token: async () => 'token',
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
    expect(v.health).toBeNull();
    expect((await h['brain:get'](v.id)).health?.outsideEdits).toEqual([]);
    expect(v.jobs).toEqual([]);
    const listed = await h['brain:list']();
    expect(listed.map((b) => b.id)).toEqual([v.id]);
    // Lists carry no health (no git, ledger or source reads).
    expect(listed[0].health).toBeNull();
    expect(broadcasts.at(-1)).toEqual(['brain:changed', { brainId: v.id }]);
    expect(events).toContainEqual([
      'brain.created',
      { wiki: false, agent: 'claude' },
    ]);
    expect(remembered).toEqual(expect.arrayContaining(['Acme', v.path]));
  });

  it('syncNow pulls then pushes a shared brain, and leaves a local one alone; a scrub of a held one folds and sends', async () => {
    const calls: string[] = [];
    const hs = createBrainHandlers({
      ...deps,
      sync: {
        pull: async (id) => {
          calls.push(`pull ${id}`);
        },
        push: async (id) => {
          calls.push(`push ${id}`);
        },
        squashUnsent: async (id) => {
          calls.push(`squash ${id}`);
          return true;
        },
      },
    });
    const v = await hs['brain:create'](NEW);
    await hs['brain:syncNow'](v.id);
    expect(calls).toEqual([]);
    const b = brains.get(v.id);
    await brains.patch(v.id, {
      sharing: {
        home: 'company',
        remoteUrl: 'https://dev.azure.com/o/p/_git/r',
        repositoryId: 'r',
        homeOrganizationUrl: 'https://dev.azure.com/o',
        homeProject: 'p',
        joinedAt: b?.createdAt ?? '',
        lastPullAt: null,
        lastPushAt: null,
        status: 'ok',
        heldFile: null,
      },
    });
    await hs['brain:syncNow'](v.id);
    expect(calls).toEqual([`pull ${v.id}`, `push ${v.id}`]);
    // A scrub of a brain whose push is held folds the unsent commits, then sends.
    calls.length = 0;
    await hs['brain:scrub'](v.id, 'not-in-this-brain-1234');
    expect(calls).toEqual([]);
    const held = brains.get(v.id)?.sharing;
    if (held)
      await brains.patch(v.id, {
        sharing: { ...held, status: 'held', heldFile: 'sources/s.md' },
      });
    await hs['brain:scrub'](v.id, 'not-in-this-brain-1234');
    expect(calls).toEqual([`squash ${v.id}`, `push ${v.id}`]);
  });

  it('pendingJoin hands over the link opened before the renderer asked, once', async () => {
    expect(await h['brain:pendingJoin']()).toBeNull();
    let pending: string | null = 'shellie://join?x';
    h = createBrainHandlers({
      ...deps,
      takePendingJoin: () => {
        const link = pending;
        pending = null;
        return link;
      },
    });
    expect(await h['brain:pendingJoin']()).toBe('shellie://join?x');
    expect(await h['brain:pendingJoin']()).toBeNull();
  });

  it('create stores the chosen agent and OpenCode model', async () => {
    const v = await h['brain:create']({
      ...NEW,
      agent: 'opencode',
      opencodeModel: 'opencode/big-pickle',
    });
    expect(v.options.agent).toBe('opencode');
    expect(v.options.opencodeModel).toBe('opencode/big-pickle');
    expect(events).toContainEqual([
      'brain.created',
      { wiki: false, agent: 'opencode' },
    ]);
    const plain = await h['brain:create'](NEW);
    expect(plain.options.agent).toBe('claude');
    expect(plain.options.opencodeModel).toBeNull();
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
      {
        type: 'note',
        format: 'text',
        sizeKb: '<10',
        outcome: 'ok',
        images: '0',
        noted: false,
      },
    ]);
  });

  it('a note given with pasted text or a file lands in the source frontmatter', async () => {
    const v = await h['brain:create'](NEW);
    const t = await h['brain:addText'](
      v.id,
      'Kick-off notes',
      'Kick-off',
      'note',
      'Rough notes, the dates are guesses',
    );
    if (!t.ok) throw new Error(t.message);
    expect(await fs.readFile(path.join(v.path, t.path), 'utf8')).toContain(
      'note: Rough notes, the dates are guesses\n',
    );
    const file = path.join(userData, 'sow.md');
    await fs.writeFile(file, '# SOW\n\nbody\n');
    const [f] = await h['brain:addFiles'](v.id, [
      {
        path: file,
        type: 'sow',
        note: '  Signed version; supersedes the draft  ',
      },
    ]);
    if (!f.ok) throw new Error(f.message);
    expect(await fs.readFile(path.join(v.path, f.path), 'utf8')).toContain(
      'note: Signed version; supersedes the draft\n',
    );
    const rows = await h['brain:sources'](v.id);
    expect(rows.map((r) => r.note).sort()).toEqual([
      'Rough notes, the dates are guesses',
      'Signed version; supersedes the draft',
    ]);
    expect(
      events
        .filter((e) => e[0] === 'brain.source.added')
        .map((e) => (e[1] as { noted: boolean }).noted),
    ).toEqual([true, true]);
  });

  it('a model given with text, files or a capture run reaches the capture only', async () => {
    const v = await h['brain:create'](NEW);
    const t = await h['brain:addText'](
      v.id,
      'Notes',
      'Kick-off',
      'note',
      undefined,
      'opus',
    );
    const file = path.join(userData, 'deck.md');
    await fs.writeFile(file, '# Deck\n\nbody\n');
    const [f] = await h['brain:addFiles'](
      v.id,
      [{ path: file, type: 'deck' }],
      'haiku',
    );
    if (!t.ok || !f.ok) throw new Error('not added');
    await h['brain:run'](v.id, 'capture', t.path, 'anthropic/claude-opus');
    await h['brain:run'](v.id, 'lint', undefined, 'opus');
    expect(enqueued).toEqual([
      [v.id, 'capture', t.path, { model: 'opus' }],
      [v.id, 'capture', f.path, { model: 'haiku' }],
      [v.id, 'capture', t.path, { model: 'anthropic/claude-opus' }],
      [v.id, 'lint', null],
    ]);
  });

  it('refuses a model that is neither a Claude Code nor an OpenCode one, before adding anything', async () => {
    const v = await h['brain:create'](NEW);
    await expect(
      h['brain:addText'](
        v.id,
        'Notes',
        'Kick-off',
        'note',
        undefined,
        'gpt 5; rm',
      ),
    ).rejects.toThrow('Unknown model gpt 5; rm');
    const file = path.join(userData, 'a.md');
    await fs.writeFile(file, '# A\n');
    await expect(
      h['brain:addFiles'](v.id, [{ path: file, type: 'doc' }], 'sonnet 4'),
    ).rejects.toThrow('Unknown model');
    expect(enqueued).toEqual([]);
    expect(await h['brain:sources'](v.id)).toEqual([]);
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
        {
          type: 'doc',
          format: 'other',
          sizeKb: '<10',
          outcome: 'unsupported',
          images: '0',
          noted: false,
        },
      ],
      [
        'brain.source.added',
        {
          type: 'doc',
          format: 'md',
          sizeKb: '<10',
          outcome: 'ok',
          images: '0',
          noted: false,
        },
      ],
    ]);
  });

  it('serves pages, search, relevance and opening a source', async () => {
    const v = await h['brain:create'](NEW);
    await fs.writeFile(
      path.join(v.path, 'wiki', 'component-billing.md'),
      '---\ntitle: Billing\nsummary: Invoices go out monthly.\nsources: [sources/k.md]\n---\n\n# Billing\n\nInvoices go out monthly.\n',
    );
    await fs.writeFile(
      path.join(v.path, 'wiki', 'account.md'),
      '---\ntitle: Acme\nsummary: Who.\nsources: [sources/k.md]\n---\n\n# Acme\n\nSee [billing](component-billing.md).\n',
    );
    const rows = await h['brain:pages'](v.id);
    expect(rows.map((r) => [r.path, r.type, r.linkedFrom])).toEqual([
      ['wiki/account.md', 'account', []],
      ['wiki/component-billing.md', 'component', ['wiki/account.md']],
    ]);
    expect(await h['brain:book'](v.id)).toBeNull();
    const hits = await h['brain:search'](v.id, 'invoices');
    expect(hits.map((x) => [x.path, x.anchor])).toEqual([
      ['wiki/component-billing.md', 'billing'],
    ]);
    const worktree = await fs.mkdtemp(path.join(userData, 'task-'));
    await fs.mkdir(path.join(worktree, '.shellie'));
    await fs.writeFile(
      path.join(worktree, '.shellie', 'task.md'),
      '# Task\n\nTouches the billing export.\n\n## Context: Acme\nnot counted invoices\n',
    );
    tasks = [
      {
        id: 't9',
        name: 'export',
        connectionId: 'c1',
        repoId: 'r1',
        worktreePath: worktree,
        workItem: { project: 'Acme', title: 'Fix the invoice export' },
      },
    ] as unknown as Task[];
    expect(await h['brain:relevant'](v.id, 't9')).toEqual([
      'wiki/component-billing.md',
    ]);
    await expect(
      h['brain:openSource'](v.id, 'wiki/account.md'),
    ).rejects.toThrow(/under sources/);
    await expect(
      h['brain:openSource'](v.id, 'sources/../SCHEMA.md'),
    ).rejects.toThrow(/under sources/);
    await expect(
      h['brain:openSource'](v.id, 'sources/k.pdf'),
    ).resolves.toBeUndefined();
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
      { id: 't4', connectionId: 'c1', repoId: 'r1', workItem: {} },
    ] as unknown as Task[];
    expect((await h['brain:forTask']('t1'))?.id).toBe(v.id);
    expect((await h['brain:forTask']('t1'))?.health).toBeNull();
    expect(await h['brain:forTask']('t3')).toBeNull();
    // A work item without a stored project (older refs): the connection's project.
    expect(await h['brain:forTask']('t4')).toBeNull();
    const d = await h['brain:create']({ ...NEW, project: 'Default' });
    expect((await h['brain:forTask']('t4'))?.id).toBe(d.id);
    // No work item: no brain, also when the connection's project has one.
    expect(await h['brain:forTask']('t2')).toBeNull();
  });

  it('sources lists the brain sources with their captured state', async () => {
    const v = await h['brain:create'](NEW);
    const r = await h['brain:addText'](v.id, 'Notes', 'Kick-off', 'note');
    if (!r.ok) throw new Error('add failed');
    expect(await h['brain:sources'](v.id)).toEqual([
      expect.objectContaining({ path: r.path, type: 'note', captured: false }),
    ]);
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
    await h['brain:terminal'](v.id, 'sess', 'What is in scope?');
    expect(openArgs.at(-1)).toEqual(['sess', 'What is in scope?']);
    await h['brain:terminal'](v.id, 'ses_1', undefined, 'opencode');
    expect(openAgents).toEqual([undefined, undefined, 'opencode']);
    await expect(h['brain:run']('nope', 'lint')).rejects.toThrow(
      'Unknown brain',
    );
  });

  describe('Run now sync and the book', () => {
    const book = JSON.stringify({ chapters: [{ title: 'A', pages: [] }] });
    const setup = async (opts: { page?: boolean; book?: boolean } = {}) => {
      const v = await h['brain:create'](NEW);
      if (opts.page ?? true)
        await fs.writeFile(
          path.join(v.path, 'wiki', 'account.md'),
          '---\ntitle: Acme\nsummary: Who.\nsources: [sources/k.md]\n---\n',
        );
      if (opts.book)
        await fs.writeFile(path.join(v.path, 'brain', 'book.json'), book);
      enqueued.length = 0;
      return v;
    };

    it('queues the sync, then one background book job, when the wiki has pages and no book', async () => {
      const v = await setup();
      await h['brain:run'](v.id, 'sync');
      expect(enqueued).toEqual([
        [v.id, 'sync', null],
        [v.id, 'sync', null, { background: true }],
      ]);
    });

    it('queues no book job when one appears while the reads are in flight', async () => {
      const v = await setup();
      const read = fs.readFile.bind(fs);
      // A book job is queued (by the scheduler, say) while the page reads are in flight.
      const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (
        ...a: unknown[]
      ) => {
        const r = await (read as (...a: unknown[]) => unknown)(...a);
        pending = [{ ...job(v.id, 'sync', null), background: true }];
        return r;
      }) as never);
      try {
        await h['brain:run'](v.id, 'sync');
      } finally {
        spy.mockRestore();
      }
      expect(enqueued).toEqual([[v.id, 'sync', null]]);
    });

    it('queues no book job with a valid book, with one pending, for an empty wiki, on old skills, or for other kinds', async () => {
      const withBook = await setup({ book: true });
      await h['brain:run'](withBook.id, 'sync');
      expect(enqueued).toEqual([[withBook.id, 'sync', null]]);

      const busy = await setup();
      pending = [{ ...job(busy.id, 'sync', null), background: true }];
      for (const status of ['queued', 'running', 'paused'] as const) {
        pending[0].status = status;
        enqueued.length = 0;
        await h['brain:run'](busy.id, 'sync');
        expect(enqueued).toEqual([[busy.id, 'sync', null]]);
      }
      pending = [];

      const empty = await setup({ page: false });
      await h['brain:run'](empty.id, 'sync');
      expect(enqueued).toEqual([[empty.id, 'sync', null]]);

      const old = await setup();
      await brains.patch(old.id, { templatesVersion: 7 });
      await h['brain:run'](old.id, 'sync');
      expect(enqueued).toEqual([[old.id, 'sync', null]]);

      const lint = await setup();
      await h['brain:run'](lint.id, 'lint');
      expect(enqueued).toEqual([[lint.id, 'lint', null]]);
    });
  });

  it('refuses a pictures job on a brain whose skills are older than v6', async () => {
    const v = await h['brain:create'](NEW);
    await brains.patch(v.id, { templatesVersion: 5 });
    await expect(
      h['brain:run'](v.id, 'pictures', 'sources/a.md'),
    ).rejects.toThrow('Update skills to re-evaluate pictures');
    expect(enqueued).toEqual([]);
    await brains.patch(v.id, { templatesVersion: 6 });
    await h['brain:run'](v.id, 'pictures', 'sources/a.md');
    expect(enqueued).toEqual([[v.id, 'pictures', 'sources/a.md']]);
  });

  it('removes a source and queues a retract; refuses while a job runs', async () => {
    const v = await h['brain:create'](NEW);
    const r = await h['brain:addText'](v.id, 'to go', 'Gone', 'note');
    if (!r.ok) throw new Error(r.message);
    enqueued.length = 0;
    await h['brain:removeSource'](v.id, r.path);
    expect(enqueued).toEqual([[v.id, 'retract', r.path]]);
    expect((await h['brain:sources'](v.id)).map((s) => s.path)).toEqual([]);
    expect((await git.run(v.path, ['log', '-1', '--format=%s'])).trim()).toBe(
      `Brain: remove source ${r.path}`,
    );
  });

  it("serves a source's pictures and accepts a drop in a commit of its own", async () => {
    const v = await h['brain:create'](NEW);
    const r = await h['brain:addText'](v.id, 'Deck', 'Deck', 'note');
    if (!r.ok) throw new Error(r.message);
    const assets = r.path.replace(/\.md$/, '-assets');
    await fs.mkdir(path.join(v.path, assets));
    await fs.writeFile(path.join(v.path, assets, 'slide-1.png'), 'png');
    await fs.writeFile(
      path.join(v.path, 'brain/pictures-dropped.json'),
      JSON.stringify({
        [r.path]: {
          dropped: [
            {
              where: 'slide 9, picture 2',
              reason: 'EMF converts on Windows only',
              fix: 'Save it as PNG',
              accepted: null,
            },
          ],
          tiny: 0,
        },
      }),
    );
    await git.run(v.path, ['add', '-A']);
    await git.run(v.path, ['commit', '-q', '-m', 'Brain: add pictures']);

    const pics = await h['brain:pictures'](v.id, r.path);
    expect(pics.source).toBe(r.path);
    expect(pics.counts).toMatchObject({ total: 2, missing: 1, dropped: 1 });
    expect(pics.rows.map((x) => [x.path, x.status])).toEqual([
      [`${assets}/slide-1.png`, 'missing'],
      [null, 'dropped'],
    ]);
    const other = await h['brain:addText'](v.id, 'Plain', 'Plain', 'note');
    if (!other.ok) throw new Error(other.message);
    expect(await h['brain:pictures'](v.id, other.path)).toMatchObject({
      counts: { total: 0, missing: 0, dropped: 0 },
      rows: [],
    });
    await fs.mkdir(path.join(v.path, 'sources/wiki/.attachments'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(v.path, 'sources/wiki/.attachments/a.png'),
      'png',
    );
    expect(
      (await h['brain:pictures'](v.id, 'sources/wiki')).rows.map((x) => x.path),
    ).toEqual(['sources/wiki/.attachments/a.png']);
    await expect(h['brain:pictures'](v.id, '../outside.md')).rejects.toThrow(
      'Only a source under sources/ has pictures',
    );

    const commits = async () =>
      Number((await git.run(v.path, ['rev-list', '--count', 'HEAD'])).trim());
    const before = await commits();
    broadcasts = [];
    await h['brain:acceptDrop'](v.id, r.path, 'slide 9, picture 2');
    expect(await commits()).toBe(before + 1);
    expect((await git.run(v.path, ['log', '-1', '--format=%s'])).trim()).toBe(
      'Brain: accepted dropped picture',
    );
    expect(
      (await git.run(v.path, ['show', '--name-only', '--format=', 'HEAD']))
        .trim()
        .split('\n'),
    ).toEqual(['brain/pictures-dropped.json']);
    expect(
      (
        await git.run(v.path, [
          'status',
          '--porcelain',
          '--',
          'brain/pictures-dropped.json',
        ])
      ).trim(),
    ).toBe('');
    expect(broadcasts).toContainEqual(['brain:changed', { brainId: v.id }]);
    const after = await h['brain:pictures'](v.id, r.path);
    expect(after.counts).toMatchObject({ dropped: 0, accepted: 1 });
    // Only the missing picture is left to flag.
    expect(
      (await h['brain:get'](v.id)).health?.findings.filter(
        (f) => f.kind === 'picture' && f.page === r.path,
      ),
    ).toEqual([
      expect.objectContaining({ detail: '1 picture not interpreted' }),
    ]);

    await expect(
      h['brain:acceptDrop'](v.id, r.path, 'slide 1, picture 1'),
    ).rejects.toThrow('Unknown dropped picture');
    expect(await commits()).toBe(before + 1);
  });

  it('accepting the only gap of a source leaves no picture finding for it', async () => {
    const v = await h['brain:create'](NEW);
    const r = await h['brain:addText'](v.id, 'Deck', 'Deck', 'note');
    if (!r.ok) throw new Error(r.message);
    await fs.writeFile(
      path.join(v.path, 'brain/pictures-dropped.json'),
      JSON.stringify({
        [r.path]: {
          dropped: [{ where: 'page 2', reason: 'r', fix: 'f', accepted: null }],
          tiny: 0,
        },
      }),
    );
    const pictureFindings = async () =>
      (await h['brain:get'](v.id)).health?.findings.filter(
        (f) => f.kind === 'picture',
      );
    expect(await pictureFindings()).toHaveLength(1);
    await h['brain:acceptDrop'](v.id, r.path, 'page 2');
    expect(await pictureFindings()).toEqual([]);
    const update = await h['brain:update'](v.id, { archived: true });
    expect(update.archived).toBe(true);
    await expect(h['brain:acceptDrop'](v.id, r.path, 'page 2')).rejects.toThrow(
      'archived',
    );
  });

  it('scrubs a value through the handler', async () => {
    const v = await h['brain:create'](NEW);
    const r = await h['brain:addText'](
      v.id,
      'the code is Zx9!secret ok',
      'S',
      'note',
    );
    if (!r.ok) throw new Error(r.message);
    expect(await h['brain:scrub'](v.id, 'Zx9!secret')).toEqual({
      files: 1,
      skipped: 0,
    });
    expect((await h['brain:read'](v.id, r.path)).text).toContain('REDACTED');
  });

  it('an archived brain refuses sources, jobs and refreshes until restored, and is no task brain', async () => {
    const v = await h['brain:create'](NEW);
    const archived = await h['brain:update'](v.id, { archived: true });
    expect(archived.archived).toBe(true);
    await expect(h['brain:addText'](v.id, 'x', 'X', 'note')).rejects.toThrow(
      /archived/,
    );
    await expect(h['brain:run'](v.id, 'lint')).rejects.toThrow(/archived/);
    await expect(h['brain:refresh'](v.id)).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/archived/),
    });
    expect(brains.forProject(NEW.connectionId, NEW.project)).toEqual([]);
    const back = await h['brain:update'](v.id, { archived: false });
    expect(back.archived).toBe(false);
    expect(
      brains.forProject(NEW.connectionId, NEW.project).map((b) => b.id),
    ).toEqual([v.id]);
  });

  it('rebuilds index.md from the pages when a job commits, and on brain:get when no job runs', async () => {
    const v = await h['brain:create'](NEW);
    const index = () => fs.readFile(path.join(v.path, 'index.md'), 'utf8');
    expect(await index()).toBe('# Acme brain\n\n(no pages yet)\n');
    // A job wrote a page: its commit lists it.
    await fs.writeFile(
      path.join(v.path, 'wiki', 'account.md'),
      '---\ntitle: Acme\nsummary: Who they are.\nsources: [sources/k.md]\n---\n',
    );
    await commitJobOutput(git, v.path, 'Brain: capture sources/k.md', v.name);
    expect(await index()).toBe(
      '# Acme brain\n\n- [Acme](wiki/account.md): Who they are.\n',
    );
    expect((await git.run(v.path, ['status', '--porcelain'])).trim()).toBe('');
    // A page added by hand: the next Health read lists it and commits only the index.
    await fs.writeFile(
      path.join(v.path, 'wiki', 'glossary.md'),
      '---\ntitle: Glossary\nsummary: Terms.\nsources: [sources/k.md]\n---\n',
    );
    const view = await h['brain:get'](v.id);
    expect(await index()).toContain('- [Glossary](wiki/glossary.md): Terms.');
    expect(view.health?.pages).toBe(2);
    expect(view.health?.outsideEdits).toEqual(['wiki/glossary.md']);
    expect((await git.run(v.path, ['log', '-1', '--format=%s'])).trim()).toBe(
      'Brain: index',
    );
    expect(
      (await git.run(v.path, ['show', '--name-only', '--format=', 'HEAD']))
        .trim()
        .split('\n'),
    ).toEqual(['index.md']);
    // Nothing changed: no new commit.
    const head = (await git.run(v.path, ['rev-parse', 'HEAD'])).trim();
    await h['brain:get'](v.id);
    expect((await git.run(v.path, ['rev-parse', 'HEAD'])).trim()).toBe(head);
  });

  it("commits a job's output, so it is not an outside edit", async () => {
    const v = await h['brain:create'](NEW);
    await fs.writeFile(path.join(v.path, 'wiki', 'account.md'), '# A\n');
    await fs.appendFile(path.join(v.path, 'log.md'), '- captured\n');
    expect((await h['brain:get'](v.id)).health?.outsideEdits).toEqual([
      'wiki/account.md',
    ]);
    await commitJobOutput(git, v.path, 'Brain: capture sources/a.md');
    expect((await h['brain:get'](v.id)).health?.outsideEdits).toEqual([]);
    expect((await git.run(v.path, ['log', '-1', '--format=%s'])).trim()).toBe(
      'Brain: capture sources/a.md',
    );
    // Nothing to commit: no empty commit.
    const count = async () =>
      (await git.run(v.path, ['rev-list', '--count', 'HEAD'])).trim();
    const n = await count();
    await commitJobOutput(git, v.path, 'Brain: lint');
    expect(await count()).toBe(n);
  });

  it('an outside edit committed before a job stays an outside edit after the job', async () => {
    const v = await h['brain:create'](NEW);
    await fs.writeFile(path.join(v.path, 'wiki', 'by-hand.md'), '# Mine\n');
    await commitJobOutput(git, v.path, OUTSIDE_EDIT_MESSAGE);
    // The job writes its own page and commits.
    await fs.writeFile(path.join(v.path, 'wiki', 'agent.md'), '# Agent\n');
    await commitJobOutput(git, v.path, 'Brain: capture sources/a.md');
    expect((await h['brain:get'](v.id)).health?.outsideEdits).toEqual([
      'wiki/by-hand.md',
    ]);
    const subjects = (await git.run(v.path, ['log', '--format=%s', '-2']))
      .trim()
      .split('\n');
    expect(subjects).toEqual([
      'Brain: capture sources/a.md',
      OUTSIDE_EDIT_MESSAGE,
    ]);
  });

  it('commits job output of an adopted brain that lacks some of its paths', async () => {
    const v = await h['brain:create'](NEW);
    await git.run(v.path, ['rm', '-q', '-r', '--', 'index.md', 'wiki']);
    await git.run(v.path, ['commit', '-q', '-m', 'Trim']);
    await fs.appendFile(path.join(v.path, 'log.md'), '- captured\n');
    await commitJobOutput(git, v.path, 'Brain: lint');
    expect((await git.run(v.path, ['log', '-1', '--format=%s'])).trim()).toBe(
      'Brain: lint',
    );
  });

  it('commits the pictures a job marked as nothing to record', async () => {
    const v = await h['brain:create'](NEW);
    const skipped = 'brain/pictures-skipped.json';
    await fs.writeFile(
      path.join(v.path, skipped),
      '{"sources/a-assets/p-1.png":{"reason":"logo","at":"2026-11-07T10:00:00Z"}}\n',
    );
    await commitJobOutput(git, v.path, 'Brain: pictures sources/a.md');
    expect(
      (
        await git.run(v.path, ['show', '--name-only', '--format=', 'HEAD'])
      ).trim(),
    ).toBe(skipped);
  });

  it('commits the book a job wrote, with the pages it added', async () => {
    const v = await h['brain:create'](NEW);
    await fs.writeFile(
      path.join(v.path, 'wiki', 'subject-mission.md'),
      '# M\n',
    );
    await fs.writeFile(
      path.join(v.path, 'brain', 'book.json'),
      '{"chapters":[]}\n',
    );
    await commitJobOutput(git, v.path, 'Brain: sync');
    expect(
      (await git.run(v.path, ['show', '--name-only', '--format=', 'HEAD']))
        .trim()
        .split('\n')
        .sort(),
    ).toEqual(['brain/book.json', 'index.md', 'wiki/subject-mission.md']);
  });

  it('job output commits leave other files alone', async () => {
    const v = await h['brain:create'](NEW);
    await fs.writeFile(path.join(v.path, 'notes.txt'), 'mine\n');
    await fs.writeFile(path.join(v.path, 'wiki', 'p.md'), '# P\n');
    await commitJobOutput(git, v.path, 'Brain: lint');
    expect((await git.run(v.path, ['status', '--porcelain'])).trim()).toBe(
      '?? notes.txt',
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
    expect(released).toEqual([v.id]);
  });

  it('update releases held jobs only when the agent changes', async () => {
    const v = await h['brain:create'](NEW);
    await h['brain:update'](v.id, { options: { weeklyDigest: true } });
    await h['brain:update'](v.id, { options: { agent: 'claude' } });
    expect(released).toEqual([]);
    await h['brain:update'](v.id, { options: { agent: 'opencode' } });
    expect(released).toEqual([v.id]);
  });

  describe('long reads', () => {
    const setup = async () => {
      const v = await h['brain:create'](NEW);
      await fs.writeFile(
        path.join(v.path, 'wiki', 'subject-orders.md'),
        '---\ntitle: Orders\nsummary: s\nsources: [sources/k.md]\n---\n\nAn order.\n',
      );
      await fs.writeFile(
        path.join(v.path, 'brain', 'book.json'),
        JSON.stringify({
          chapters: [{ title: 'Orders', pages: ['wiki/subject-orders.md'] }],
        }),
      );
      enqueued.length = 0;
      return v;
    };
    const read =
      '---\ntitle: Order to invoice\nchapter: Orders\npages:\n  - wiki/subject-orders.md\n---\n\nAn order is a promise.\n';

    it('lists none for a new brain, then the long read with its chapter', async () => {
      const v = await setup();
      expect(await h['brain:reads'](v.id)).toEqual({ reads: [], letters: [] });
      await fs.mkdir(path.join(v.path, 'reads'));
      await fs.writeFile(path.join(v.path, 'reads', 'order.md'), read);
      const r = await h['brain:reads'](v.id);
      expect(r.reads).toHaveLength(1);
      expect(r.reads[0]).toMatchObject({
        path: 'reads/order.md',
        title: 'Order to invoice',
        chapter: 'Orders',
        stale: [],
      });
    });

    it('queues a write for a chapter, a topic and an update, with the target as the job carries it', async () => {
      const v = await setup();
      await fs.mkdir(path.join(v.path, 'reads'));
      await fs.writeFile(path.join(v.path, 'reads', 'order.md'), read);
      await h['brain:write'](v.id, 'chapter:orders');
      await h['brain:write'](v.id, 'topic: Credit notes ');
      await h['brain:write'](v.id, 'reads/order.md');
      expect(enqueued).toEqual([
        [v.id, 'write', null, { target: 'chapter:Orders' }],
        [v.id, 'write', null, { target: 'topic:Credit notes' }],
        [v.id, 'write', null, { target: 'reads/order.md' }],
      ]);
    });

    it('queues one write per target at a time', async () => {
      const v = await setup();
      const waiting = { ...job(v.id, 'write', null), target: 'chapter:Orders' };
      pending = [waiting];
      expect(await h['brain:write'](v.id, 'chapter:Orders')).toBe(waiting);
      expect(enqueued).toEqual([]);
      pending = [{ ...waiting, status: 'done' }];
      await h['brain:write'](v.id, 'chapter:Orders');
      expect(enqueued).toHaveLength(1);
    });

    it('refuses on old skills, for an archived brain, and for a target that does not hold', async () => {
      const v = await setup();
      await expect(h['brain:write'](v.id, 'chapter:Nope')).rejects.toThrow(
        'The book has no such chapter',
      );
      await expect(h['brain:write'](v.id, 'wiki/account.md')).rejects.toThrow(
        'not something to write a long read on',
      );
      await expect(h['brain:write'](v.id, 'reads/nope.md')).rejects.toThrow(
        'That long read is gone',
      );
      await brains.patch(v.id, { templatesVersion: 9 });
      await expect(h['brain:write'](v.id, 'chapter:Orders')).rejects.toThrow(
        'Update skills to write long reads',
      );
      await brains.patch(v.id, { templatesVersion: 10, archived: true });
      await expect(h['brain:write'](v.id, 'chapter:Orders')).rejects.toThrow(
        'archived',
      );
      expect(enqueued).toEqual([]);
    });

    it('Run now never queues a write', async () => {
      const v = await setup();
      await expect(h['brain:run'](v.id, 'write' as never)).rejects.toThrow(
        'A long read needs something to write about',
      );
    });

    it("commits a job's long reads and their record with its output", async () => {
      const v = await setup();
      await commitJobOutput(git, v.path, 'Brain: sync', v.name);
      await fs.mkdir(path.join(v.path, 'reads', 'letters'), {
        recursive: true,
      });
      await fs.writeFile(path.join(v.path, 'reads', 'order.md'), read);
      await fs.writeFile(
        path.join(v.path, 'reads', 'letters', '2026-11-11-order.md'),
        '---\nread: reads/order.md\n---\n',
      );
      await fs.writeFile(
        path.join(v.path, 'brain', 'reads.json'),
        '{ "reads": {} }\n',
      );
      await commitJobOutput(git, v.path, 'Brain: write', v.name);
      expect(
        (await git.run(v.path, ['show', '--name-only', '--format=%s', 'HEAD']))
          .trim()
          .split('\n')
          .filter(Boolean),
      ).toEqual([
        'Brain: write',
        'brain/reads.json',
        'reads/letters/2026-11-11-order.md',
        'reads/order.md',
      ]);
    });
  });

  describe('settling conflicts', () => {
    const conflict = {
      id: 'contradiction:wiki/a.md+wiki/b.md:go-live',
      question: 'When does Acme go live?',
      claims: {
        a: { page: 'wiki/a.md', quote: '12 January' },
        b: { page: 'wiki/b.md', quote: '2 February' },
      },
    };
    const decision = {
      id: conflict.id,
      kind: 'contradiction' as const,
      page: 'wiki/a.md',
      question: conflict.question,
      detail: 'go-live differs',
      claims: null,
      choice: 'b' as const,
      text: null,
      why: 'steerco',
      answer: null,
    };
    const withFinding = async () => {
      const v = await h['brain:create'](NEW);
      await fs.writeFile(
        path.join(v.path, 'brain', 'state.json'),
        JSON.stringify({
          schemaVersion: 1,
          findings: [
            {
              kind: 'contradiction',
              page: 'wiki/a.md',
              detail: 'go-live differs',
              at: '2026-11-10T08:00:00.000Z',
              conflict,
            },
          ],
        }),
      );
      return v;
    };

    it('lists open conflicts, then parks one and brings it back', async () => {
      const v = await withFinding();
      expect((await h['brain:conflicts'](v.id)).open.map((c) => c.id)).toEqual([
        conflict.id,
      ]);
      await h['brain:park'](v.id, conflict.id, 'Which date?');
      const parked = await h['brain:conflicts'](v.id);
      expect(parked.open).toEqual([]);
      expect(parked.parked[0]).toMatchObject({
        id: conflict.id,
        question: 'Which date?',
      });
      await h['brain:unpark'](v.id, conflict.id);
      expect((await h['brain:conflicts'](v.id)).open).toHaveLength(1);
    });

    it('settle records the decision as pending and queues one settle job for it', async () => {
      const v = await withFinding();
      await h['brain:park'](v.id, conflict.id, 'Which date?');
      broadcasts = [];
      await h['brain:settle'](v.id, decision);
      expect(enqueued).toEqual([
        [v.id, 'settle', null, { conflict: conflict.id }],
      ]);
      const c = await h['brain:conflicts'](v.id);
      expect(c.open).toEqual([]);
      expect(c.parked).toEqual([]);
      expect(c.settled[0]).toMatchObject({
        id: conflict.id,
        status: 'pending',
        choice: 'b',
      });
      expect(broadcasts).toContainEqual(['brain:changed', { brainId: v.id }]);
      // A settle already queued for it is not queued twice.
      pending = [{ ...job(v.id, 'settle', null), conflict: conflict.id }];
      await h['brain:settle'](v.id, decision);
      expect(enqueued).toHaveLength(1);
    });

    it('refuses a settle on skills older than v9, or a decision that is not one', async () => {
      const v = await withFinding();
      await brains.patch(v.id, { templatesVersion: 8 });
      await expect(h['brain:settle'](v.id, decision)).rejects.toThrow(
        'Update skills to settle conflicts here',
      );
      await brains.patch(v.id, { templatesVersion: TEMPLATES_VERSION });
      await expect(
        h['brain:settle'](v.id, { ...decision, choice: 'maybe' } as never),
      ).rejects.toThrow();
      expect(enqueued).toEqual([]);
      await expect(h['brain:run'](v.id, 'settle' as never)).rejects.toThrow();
    });

    it('Retry queues a failed settle again from the decision it kept', async () => {
      const v = await withFinding();
      await updateConflicts(v.path, () => ({
        version: 1,
        conflicts: {
          [conflict.id]: {
            settled: {
              at: new Date().toISOString(),
              status: 'failed',
              decision,
              page: null,
              error: 'boom',
            },
          },
        },
      }));
      await h['brain:settleRetry'](v.id, conflict.id);
      expect(enqueued).toEqual([
        [v.id, 'settle', null, { conflict: conflict.id }],
      ]);
      expect((await h['brain:conflicts'](v.id)).settled[0]).toMatchObject({
        status: 'pending',
        error: null,
      });
    });

    it("keeps someone's answer with its conflict: a source with no capture, the conflict open again with it", async () => {
      const v = await withFinding();
      await h['brain:park'](v.id, conflict.id, 'Which date?');
      const r = await h['brain:answer'](v.id, conflict.id, 'Yes, 2 February.');
      expect(r.path).toMatch(/^sources\/.*answer-when-does-acme-go-live/);
      expect(enqueued).toEqual([]);
      const c = await h['brain:conflicts'](v.id);
      expect(c.parked).toEqual([]);
      expect(c.open[0]).toMatchObject({
        id: conflict.id,
        answer: { path: r.path, text: 'Yes, 2 February.' },
      });
      expect(c.answers).toEqual([r.path]);
      expect(await fs.readFile(path.join(v.path, r.path), 'utf8')).toContain(
        'Yes, 2 February.',
      );
    });

    it('commits brain/conflicts.json with each park and settle', async () => {
      const v = await withFinding();
      await h['brain:park'](v.id, conflict.id, 'Which date?');
      await h['brain:settle'](v.id, decision);
      const log = await git.run(v.path, [
        'log',
        '--format=%s',
        '-2',
        '--',
        'brain/conflicts.json',
      ]);
      expect(log.trim().split('\n')).toEqual([
        'Brain: settle conflict',
        'Brain: park conflict',
      ]);
      expect(
        (
          await git.run(v.path, [
            'status',
            '--porcelain',
            '--',
            'brain/conflicts.json',
          ])
        ).trim(),
      ).toBe('');
    });

    it('adds an answer as a source without queuing a capture', async () => {
      const v = await withFinding();
      const r = await h['brain:addText'](
        v.id,
        'Yes, 2 February.',
        'Answer: When?',
        'note',
        'Answer to a conflict',
        undefined,
        { capture: false },
      );
      expect(r.ok).toBe(true);
      expect(enqueued).toEqual([]);
    });
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

    it('queues a pictures job for the mirror when its attachments changed', async () => {
      await fs.mkdir(path.join(wikiRepo, '.attachments'), { recursive: true });
      await fs.writeFile(path.join(wikiRepo, '.attachments/a.png'), 'png');
      sh(wikiRepo, 'add', '-A');
      sh(wikiRepo, 'commit', '-q', '-m', 'attachment');
      commitFile(wikiRepo, 'Home.md', '# Home\n![a](/.attachments/a.png)\n');
      const v = await h['brain:create']({ ...NEW, wiki });
      await h['brain:update'](v.id, { options: { syncAfterRefresh: true } });
      expect(await h['brain:refresh'](v.id)).toMatchObject({
        ok: true,
        attachments: 1,
      });
      expect(enqueued).toEqual([
        [v.id, 'sync', null],
        [v.id, 'pictures', 'sources/wiki'],
      ]);
      // The same attachment again: nothing queued.
      await h['brain:refresh'](v.id);
      expect(enqueued).toHaveLength(2);
    });

    it('queues no pictures job for the mirror on a brain whose skills are older than v6', async () => {
      await fs.mkdir(path.join(wikiRepo, '.attachments'), { recursive: true });
      await fs.writeFile(path.join(wikiRepo, '.attachments/a.png'), 'png');
      sh(wikiRepo, 'add', '-A');
      sh(wikiRepo, 'commit', '-q', '-m', 'attachment');
      commitFile(wikiRepo, 'Home.md', '# Home\n![a](/.attachments/a.png)\n');
      const v = await h['brain:create']({ ...NEW, wiki });
      await brains.patch(v.id, { templatesVersion: 5 });
      expect(await h['brain:refresh'](v.id)).toMatchObject({
        ok: true,
        attachments: 1,
      });
      expect(enqueued).toEqual([]);
    });

    it('refuses while a brain job holds the lock, and works after it is released', async () => {
      const v = await h['brain:create']({ ...NEW, wiki });
      const head = async () =>
        (await git.run(v.path, ['rev-parse', 'HEAD'])).trim();
      const before = await head();
      expect(await acquireLock(v.path)).toBe(true);
      expect(await h['brain:refresh'](v.id)).toEqual({
        ok: false,
        message: 'A brain job is running; try again later',
      });
      expect(await head()).toBe(before);
      expect(events.some((e) => e[0] === 'brain.refresh')).toBe(false);
      await releaseLock(v.path);
      expect(await h['brain:refresh'](v.id)).toMatchObject({ ok: true });
      expect(await head()).not.toBe(before);
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

describe('index rebuilds that overlap', () => {
  const git = new GitClient();
  let root: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-index-race-')),
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a Health rebuild and a job start at the same moment both succeed', async () => {
    const dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
    for (let i = 0; i < 40; i++)
      await fs.writeFile(
        path.join(dir, 'wiki', `component-${i}.md`),
        `---\ntitle: C${i}\nsummary: s\nsources: [sources/k.md]\n---\n`,
      );
    for (let round = 0; round < 5; round++) {
      await fs.writeFile(
        path.join(dir, 'wiki', `decision-2026-11-0${round + 1}-r.md`),
        `---\ntitle: R${round}\nsummary: s\nsources: [sources/k.md]\n---\n`,
      );
      const results = await Promise.allSettled([
        refreshIndex(git, dir, 'Acme'),
        commitJobOutput(git, dir, OUTSIDE_EDIT_MESSAGE, 'Acme'),
        refreshIndex(git, dir, 'Acme'),
      ]);
      expect(results.map((r) => r.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ]);
    }
    const index = await fs.readFile(path.join(dir, 'index.md'), 'utf8');
    expect(index).toContain('- [R4](wiki/decision-2026-11-05-r.md): s');
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
  });
});

describe('verifyPage', () => {
  const git = new GitClient();
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-verify-')),
    );
    dir = path.join(root, 'brain');
    await scaffoldBrain(git, dir, 'Acme');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes today as verified, replacing an older one, and commits the page alone', async () => {
    const page = path.join(dir, 'wiki', 'account.md');
    await fs.writeFile(
      page,
      '---\ntitle: Acme\nsummary: Who.\nverified: 2026-10-01\nlast_updated: 2026-11-01\n---\n\n# Acme\n',
    );
    await fs.writeFile(path.join(dir, 'wiki', 'other.md'), '# Other\n');
    const day = await verifyPage(
      git,
      dir,
      'wiki/account.md',
      new Date(2026, 10, 4, 9),
    );
    expect(day).toBe('2026-11-04');
    expect(await fs.readFile(page, 'utf8')).toBe(
      '---\ntitle: Acme\nsummary: Who.\nlast_updated: 2026-11-01\nverified: 2026-11-04\n---\n\n# Acme\n',
    );
    expect((await git.run(dir, ['log', '-1', '--format=%s'])).trim()).toBe(
      'Brain: verified wiki/account.md',
    );
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe(
      '?? wiki/other.md',
    );
    await expect(
      verifyPage(git, dir, 'wiki/other.md', new Date()),
    ).rejects.toThrow(/no frontmatter/);
    await expect(
      verifyPage(git, dir, 'sources/x.md', new Date()),
    ).rejects.toThrow(/under wiki/);
    await expect(
      verifyPage(git, dir, 'wiki/../SCHEMA.md', new Date()),
    ).rejects.toThrow(/under wiki/);
    // A dotted name is a name; a dot segment normalises away.
    await fs.writeFile(
      path.join(dir, 'wiki', 'a..b.md'),
      '---\ntitle: AB\n---\n',
    );
    await verifyPage(git, dir, 'wiki/./a..b.md', new Date(2026, 10, 4));
    expect((await git.run(dir, ['log', '-1', '--format=%s'])).trim()).toBe(
      'Brain: verified wiki/a..b.md',
    );
  });

  it('commits a hand edit of the page as an outside edit first, and skips a repeat on the same day', async () => {
    const page = path.join(dir, 'wiki', 'account.md');
    await fs.writeFile(page, '---\ntitle: Acme\n---\n\nOld.\n');
    await git.run(dir, ['add', '-A']);
    await git.run(dir, ['commit', '-q', '-m', 'Brain: sync']);
    await fs.writeFile(page, '---\ntitle: Acme\n---\n\nEdited by hand.\n');
    await verifyPage(git, dir, 'wiki/account.md', new Date(2026, 10, 4));
    const subjects = (await git.run(dir, ['log', '--format=%s', '-3']))
      .trim()
      .split('\n');
    expect(subjects).toEqual([
      'Brain: verified wiki/account.md',
      OUTSIDE_EDIT_MESSAGE,
      'Brain: sync',
    ]);
    const h = await brainHealth(dir, git, { tokens: 0, costEur: 0 }, false);
    expect(h.outsideEdits).toEqual(['wiki/account.md']);
    const head = (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
    await verifyPage(git, dir, 'wiki/account.md', new Date(2026, 10, 4));
    expect((await git.run(dir, ['rev-parse', 'HEAD'])).trim()).toBe(head);
  });
});
