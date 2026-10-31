import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../shared/types';
import { GitClient } from '../services/GitClient';
import {
  cleanupTempRepos,
  tempRoots,
  git as gitOut,
  makeRepo,
} from '../test-helpers/gitRepo';
import { DocsWatcher } from './DocsWatcher';
import { allowedLink, createDocsHandlers } from './docsHandlers';
import { SessionDocs } from './sessionDocs';
import { claudeProjectFolder } from '../services/claudeSessions';

afterAll(() => cleanupTempRepos());

function setup(status: Task['status'] = 'ready') {
  const repo = makeRepo();
  const task = {
    id: 't1',
    status,
    worktreePath: repo,
    baseSha: null,
    homeDropped: false,
    extraWorkspaces: [],
    terminals: [],
    closedTerminals: [],
    createdAt: '2026-10-19T09:00:00Z',
  } as unknown as Task;
  const launch = vi.fn(
    async (_ws: unknown, _file: string, _line?: number, _col?: number) =>
      undefined,
  );
  const openExternal = vi.fn(async () => undefined);
  const revealFile = vi.fn();
  const watcher = new DocsWatcher(() => undefined);
  const openPath = vi.fn(async (_p: string) => '');
  const grantView = vi.fn(
    (f: string) => `shellie-view://tok/${path.basename(f)}`,
  );
  const h = createDocsHandlers({
    taskById: () => task,
    git: new GitClient(),
    openFile: launch,
    openExternal,
    openPath,
    grantView,
    revealFile,
    watcher,
    session: new SessionDocs({
      git: new GitClient(),
      projectsDir: () => '/nonexistent',
    }),
    event: () => undefined,
  });
  return {
    repo,
    h,
    launch,
    openExternal,
    revealFile,
    watcher,
    openPath,
    grantView,
  };
}

describe('docs handlers', () => {
  it('lists and reads for a ready task', async () => {
    const { h } = setup();
    expect((await h['docs:list']('t1')).files.map((f) => f.path)).toEqual([
      'README.md',
    ]);
    expect((await h['docs:read']('t1', 'README.md')).text).toBe('# test\n');
  });
  it('refuses a task that is not ready', async () => {
    const { h } = setup('done');
    await expect(h['docs:list']('t1')).rejects.toThrow(
      'Cannot read docs of a task that is done',
    );
  });
  it('opens the editor at the file and line', async () => {
    const { h, launch, repo } = setup();
    await h['docs:openInEditor']('t1', 'README.md', 3, 2);
    expect(launch.mock.calls[0].slice(1)).toEqual([
      realpathSync(path.join(repo, 'README.md')),
      3,
      2,
    ]);
  });
  it('refuses a line or column that is not a positive integer', async () => {
    const { h, launch } = setup();
    for (const [line, col] of [
      [0, 1],
      [1.5, 1],
      [3, -1],
      ['3', 1],
    ] as const)
      await expect(
        h['docs:openInEditor']('t1', 'README.md', line as number, col),
      ).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
    await h['docs:openInEditor']('t1', 'README.md');
    expect(launch.mock.calls[0].slice(2)).toEqual([undefined, undefined]);
  });
  it('refuses to reveal or open outside the worktree', async () => {
    const { h, revealFile } = setup();
    await expect(h['docs:reveal']('t1', '../x')).rejects.toThrow(
      'Outside the worktree',
    );
    expect(revealFile).not.toHaveBeenCalled();
  });
  it('watch on/off reports live', async () => {
    const { h, watcher } = setup();
    expect(await h['docs:watch']('t1', true)).toEqual({ live: true });
    expect(watcher.active('t1')).toBe(true);
    await h['docs:watch']('t1', false);
    expect(watcher.active('t1')).toBe(false);
  });
  it('watch falls back to polling when the worktree is missing', async () => {
    const { h, repo, watcher } = setup();
    rmSync(repo, { recursive: true, force: true });
    expect(await h['docs:watch']('t1', true)).toEqual({ live: false });
    expect(watcher.active('t1')).toBe(false);
  });
  it('watch falls back to polling for a task that is not ready', async () => {
    const { h, watcher } = setup('done');
    expect(await h['docs:watch']('t1', true)).toEqual({ live: false });
    expect(watcher.active('t1')).toBe(false);
  });
});

describe('docs handlers across workspaces', () => {
  function multi() {
    const home = makeRepo('home');
    const extra = makeRepo('extra');
    writeFileSync(path.join(extra, 'only-extra.md'), '# extra\n');
    const task = {
      id: 't1',
      status: 'ready',
      worktreePath: home,
      baseSha: null,
      homeDropped: false,
      extraWorkspaces: [
        {
          id: 'w2',
          repoId: 'r2',
          branch: 'b',
          worktreePath: extra,
          baseRef: 'main',
          baseSha: gitOut(extra, 'rev-parse', 'HEAD').trim(),
          source: 'detected',
          dropped: false,
        },
      ],
    } as unknown as Task;
    const h = createDocsHandlers({
      taskById: () => task,
      git: new GitClient(),
      openFile: vi.fn(async () => undefined),
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => ''),
      grantView: () => 'shellie-view://tok/x.html',
      revealFile: vi.fn(),
      watcher: new DocsWatcher(() => undefined),
      session: new SessionDocs({
        git: new GitClient(),
        projectsDir: () => '/nonexistent',
      }),
      event: () => undefined,
    });
    return { h, extra };
  }
  it('lists an extra workspace marked against its own base', async () => {
    const { h } = multi();
    const files = (await h['docs:list']('t1#w2')).files;
    expect(files.map((f) => f.path).sort()).toEqual([
      'README.md',
      'only-extra.md',
    ]);
    expect(files.find((f) => f.path === 'only-extra.md')?.changed).toBe('new');
    expect(files.find((f) => f.path === 'README.md')?.changed).toBeNull();
    expect((await h['docs:list']('t1')).files.map((f) => f.path)).toEqual([
      'README.md',
    ]);
  });
  it('resolves a link that exists only in an extra workspace', async () => {
    const { h } = multi();
    expect(await h['docs:resolve']('t1', 'only-extra.md')).toEqual({
      path: 'only-extra.md',
      kind: 'md',
      workspaceId: 'w2',
    });
    expect(await h['docs:resolve']('t1', 'README.md')).toEqual({
      path: 'README.md',
      kind: 'md',
    });
    expect(await h['docs:resolve']('t1', 'nope.md')).toBeNull();
    expect(await h['docs:resolve']('t1#w2', 'README.md')).toMatchObject({
      workspaceId: 'w2',
    });
  });
});

describe('docs handlers with session docs', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
  function session() {
    const repo = makeRepo('home');
    const tmp = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'shellie-sd-')),
    );
    const projects = path.join(tmp, 'claude', 'projects');
    const outside = path.join(tmp, 'investigations');
    const elsewhere = path.join(tmp, 'elsewhere');
    mkdirSync(path.join(outside, 'img'), { recursive: true });
    mkdirSync(elsewhere);
    writeFileSync(path.join(outside, 'push-order.md'), '# Push order\n');
    writeFileSync(path.join(outside, 'not-mine.md'), '# private\n');
    writeFileSync(path.join(outside, 'img', 'a.png'), PNG);
    writeFileSync(path.join(elsewhere, 'b.png'), PNG);
    writeFileSync(path.join(repo, 'plan.md'), '# Plan\n');
    writeFileSync(path.join(repo, 'gone.md'), '# gone\n');
    const folder = path.join(projects, claudeProjectFolder(repo));
    mkdirSync(folder, { recursive: true });
    const use = (name: string, file_path: string) =>
      JSON.stringify({
        type: 'assistant',
        cwd: repo,
        timestamp: '2026-10-19T10:00:00Z',
        message: {
          content: [{ type: 'tool_use', name, input: { file_path } }],
        },
      });
    writeFileSync(
      path.join(folder, 's1.jsonl'),
      [
        use('Write', path.join(outside, 'push-order.md')),
        use('Edit', 'plan.md'),
        use('Write', path.join(repo, 'gone.md')),
        '{not json',
      ].join('\n') + '\n',
    );
    rmSync(path.join(repo, 'gone.md'));
    const task = {
      id: 't1',
      status: 'ready',
      worktreePath: repo,
      baseSha: gitOut(repo, 'rev-parse', 'HEAD').trim(),
      homeDropped: false,
      extraWorkspaces: [],
      createdAt: '2026-10-19T09:00:00Z',
      terminals: [
        { id: 'a', kind: 'claude', label: 'Claude', sessionId: 's1' },
      ],
      closedTerminals: [],
    } as unknown as Task;
    const revealFile = vi.fn();
    const h = createDocsHandlers({
      taskById: () => task,
      git: new GitClient(),
      openFile: vi.fn(async () => undefined),
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => ''),
      grantView: () => 'shellie-view://tok/x.html',
      revealFile,
      watcher: new DocsWatcher(() => undefined),
      session: new SessionDocs({
        git: new GitClient(),
        projectsDir: () => projects,
      }),
      event: () => undefined,
    });
    tempRoots.push(tmp);
    return { h, repo, outside, elsewhere, revealFile };
  }
  it('lists what Claude wrote (inside and outside) and what changed, only files that exist', async () => {
    const { h, outside } = session();
    const files = (await h['docs:session']('t1')).files;
    expect(
      files.map(({ path: p, workspaceId, claude, changed }) => ({
        p,
        workspaceId,
        claude,
        changed,
      })),
    ).toEqual([
      {
        p: path.join(outside, 'push-order.md').split(path.sep).join('/'),
        workspaceId: null,
        claude: true,
        changed: null,
      },
      { p: 'plan.md', workspaceId: 'home', claude: true, changed: 'new' },
    ]);
  });
  it('reads an outside session doc, and refuses any other outside file', async () => {
    const { h, outside } = session();
    expect(
      (await h['docs:read']('t1', path.join(outside, 'push-order.md'))).text,
    ).toBe('# Push order\n');
    await expect(
      h['docs:read']('t1', path.join(outside, 'not-mine.md')),
    ).rejects.toThrow('Outside the worktree');
    await expect(
      h['docs:read']('t1', '../investigations/push-order.md'),
    ).rejects.toThrow('Outside the worktree');
  });
  it('serves images only from an outside session doc folder tree', async () => {
    const { h, outside, elsewhere } = session();
    expect(
      await h['docs:asset']('t1', path.join(outside, 'img', 'a.png')),
    ).toMatch(/^data:image\/png;base64,/);
    await expect(
      h['docs:asset']('t1', path.join(elsewhere, 'b.png')),
    ).rejects.toThrow('Outside the worktree');
  });
  it('resolves a terminal path to an outside session doc, and nothing else outside', async () => {
    const { h, outside, revealFile, repo } = session();
    const abs = path.join(outside, 'push-order.md');
    expect(await h['docs:resolve']('t1', abs)).toEqual({
      path: abs.split(path.sep).join('/'),
      kind: 'md',
    });
    expect(await h['docs:resolve']('t1', path.relative(repo, abs))).toEqual({
      path: abs.split(path.sep).join('/'),
      kind: 'md',
    });
    expect(
      await h['docs:resolve']('t1', path.join(outside, 'not-mine.md')),
    ).toBeNull();
    await h['docs:reveal']('t1', abs);
    // Revealed by its real path (Windows' temp folder has an 8.3 short name in it).
    expect(revealFile).toHaveBeenCalledWith(realpathSync.native(abs));
    await expect(
      h['docs:reveal']('t1', path.join(outside, 'not-mine.md')),
    ).rejects.toThrow('Outside the worktree');
  });
});

describe('HTML files', () => {
  function html() {
    const s = setup();
    mkdirSync(path.join(s.repo, 'report'));
    writeFileSync(path.join(s.repo, 'report', 'index.html'), '<h1>r</h1>');
    const tmp = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), 'shellie-html-')),
    );
    tempRoots.push(tmp);
    const outside = path.join(tmp, 'reviews', 'pr-759');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'index.html'), '<h1>pr</h1>');
    writeFileSync(path.join(outside, 'notes.txt'), 'x');
    return { ...s, outside };
  }
  const slash = (p: string) => p.split(path.sep).join('/');

  it('resolves a worktree HTML file as html', async () => {
    const { h } = html();
    expect(await h['docs:resolve']('t1', 'report/index.html')).toEqual({
      path: 'report/index.html',
      kind: 'html',
    });
  });
  it('resolves an absolute HTML file outside the worktrees, nothing else outside', async () => {
    const { h, outside } = html();
    const abs = path.join(outside, 'index.html');
    expect(await h['docs:resolve']('t1', abs)).toEqual({
      path: slash(abs),
      kind: 'html',
    });
    expect(
      await h['docs:resolve']('t1', path.join(outside, 'missing.html')),
    ).toBeNull();
    expect(
      await h['docs:resolve']('t1', path.join(outside, 'notes.txt')),
    ).toBeNull();
    // Only absolute paths reach outside the worktrees: a relative one resolves inside them.
    expect(
      await h['docs:resolve']('t1', 'reviews/pr-759/index.html'),
    ).toBeNull();
  });
  it('never looks at UNC or //host paths', async () => {
    const { h } = html();
    expect(
      await h['docs:resolve']('t1', '\\\\server\\share\\a.html'),
    ).toBeNull();
    expect(await h['docs:resolve']('t1', '//server/share/a.html')).toBeNull();
  });
  it('html:open grants worktree and absolute outside HTML files', async () => {
    const { h, grantView, repo, outside } = html();
    expect(await h['html:open']('t1', 'report/index.html')).toEqual({
      url: 'shellie-view://tok/index.html',
      name: 'index.html',
    });
    expect(grantView).toHaveBeenLastCalledWith(
      realpathSync.native(path.join(repo, 'report', 'index.html')),
    );
    await h['html:open']('t1', slash(path.join(outside, 'index.html')));
    expect(grantView).toHaveBeenLastCalledWith(
      realpathSync.native(path.join(outside, 'index.html')),
    );
  });
  it('html:open refuses what is not an existing HTML file', async () => {
    const { h, grantView, outside } = html();
    await expect(h['html:open']('t1', 'README.md')).rejects.toThrow(
      'Not an HTML file',
    );
    await expect(
      h['html:open']('t1', path.join(outside, 'notes.txt')),
    ).rejects.toThrow('Not an HTML file');
    await expect(
      h['html:open']('t1', path.join(outside, 'gone.html')),
    ).rejects.toThrow('Not found');
    await expect(h['html:open']('t1', 'nope.html')).rejects.toThrow(
      'Not found',
    );
    await expect(
      h['html:open']('t1', '../../somewhere/x.html'),
    ).rejects.toThrow('Outside the worktree');
    expect(grantView).not.toHaveBeenCalled();
  });
  it('html:openExternal opens the file with its default app', async () => {
    const { h, openPath, outside } = html();
    await h['html:openExternal']('t1', path.join(outside, 'index.html'));
    expect(openPath).toHaveBeenCalledWith(
      realpathSync.native(path.join(outside, 'index.html')),
    );
    openPath.mockResolvedValueOnce('No application');
    await expect(
      h['html:openExternal']('t1', 'report/index.html'),
    ).rejects.toThrow('Could not open the file: No application');
    await expect(h['html:openExternal']('t1', 'README.md')).rejects.toThrow(
      'Not an HTML file',
    );
  });
});

describe('allowedLink', () => {
  it.each([
    ['https://example.com/a?b=1', true],
    ['http://localhost:5173/', true],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['https://user:pw@example.com', false],
    ['not a url', false],
  ])('%s -> %s', (url, ok) => expect(allowedLink(url)).toBe(ok));
});
