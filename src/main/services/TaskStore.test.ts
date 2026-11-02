import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from './TaskStore';

const tmpDirs: string[] = [];

const tmp = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shellie-store-'));
  tmpDirs.push(root);
  return path.join(root, 'nested', 'state.json');
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('TaskStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = new TaskStore(tmp());
    const result = await store.load();
    expect(result).toEqual({ recovered: false });
    expect(store.state).toEqual({
      version: 1,
      repos: [],
      tasks: [],
      discardedCleanup: [],
    });
  });

  it('persists updates and reads them back', async () => {
    const file = tmp();
    const store = new TaskStore(file);
    await store.load();
    await store.update((s) => {
      s.repos.push({
        id: 'r1',
        name: 'webshop',
        path: '/src/webshop',
        baseBranch: 'main',
        connectionId: null,
        configFound: true,
        discovered: false,
        overrides: {},
        workItemOnStart: {
          moveToInProgress: true,
          assignToMe: true,
          stateOverrides: {},
        },
      });
    });
    const again = new TaskStore(file);
    await again.load();
    expect(again.state.repos).toHaveLength(1);
    expect(again.state.repos[0].name).toBe('webshop');
    expect(readdirSync(path.dirname(file))).toEqual(['state.json']);
  });

  it('loads a task without pullRequest', async () => {
    const file = tmp();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        repos: [],
        tasks: [
          {
            id: 't1',
            repoId: 'r1',
            name: 'Old task',
            workItem: null,
            slug: 'old-task',
            branch: 'task/old-task',
            worktreePath: '/wt/old-task',
            baseRef: 'origin/main',
            status: 'ready',
            setup: {
              copy: false,
              commands: [],
              startClaude: false,
              openShell: false,
            },
            terminals: [],
            createdAt: '2026-10-01T00:00:00.000Z',
            finishedAt: null,
          },
        ],
      }),
    );
    const store = new TaskStore(file);
    await store.load();
    expect(store.state.tasks[0].pullRequest).toBeNull();
  });

  it('loads the pre-workspace shape with defaults for the multi-repo fields', async () => {
    const file = tmp();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        repos: [
          {
            id: 'r1',
            name: 'webshop',
            path: '/src/webshop',
            baseBranch: 'main',
            connectionId: null,
            configFound: true,
            discovered: false,
            overrides: {},
          },
        ],
        tasks: [
          {
            id: 't1',
            repoId: 'r1',
            name: 'Old task',
            workItem: null,
            slug: 'old-task',
            branch: 'task/old-task',
            worktreePath: '/wt/old-task',
            baseRef: 'origin/main',
            status: 'ready',
            setup: {
              copy: false,
              commands: [],
              startClaude: false,
              openShell: false,
            },
            terminals: [],
            createdAt: '2026-10-01T00:00:00.000Z',
            finishedAt: null,
          },
        ],
      }),
    );
    const store = new TaskStore(file);
    await store.load();
    expect(store.state.tasks[0]).toMatchObject({
      extraWorkspaces: [],
      detachedPaths: [],
      homeDropped: false,
      connectionId: null,
      mainCheckoutEdits: [],
    });
    expect(store.state.repos[0].discovered).toBe(false);
  });

  it('does not change state when the mutation produces an invalid state', async () => {
    const store = new TaskStore(tmp());
    await store.load();
    await expect(
      store.update((s) => {
        (s as { version: number }).version = 9;
      }),
    ).rejects.toThrow();
    expect(store.state.version).toBe(1);
  });

  it('keeps a backup and starts empty when the file is corrupt', async () => {
    const file = tmp();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    const store = new TaskStore(file);
    const result = await store.load();
    expect(result.recovered).toBe(true);
    expect(result.backup).toMatch(/state\.json\.corrupt-\d+$/);
    expect(readFileSync(result.backup!, 'utf8')).toBe('{ not json');
    expect(store.state).toEqual({
      version: 1,
      repos: [],
      tasks: [],
      discardedCleanup: [],
    });
  });

  it('falls back to copying the corrupt file when rename fails', async () => {
    const file = tmp();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV'), { code: 'EXDEV' }),
    );
    const store = new TaskStore(file);
    const result = await store.load();
    expect(result.recovered).toBe(true);
    expect(readFileSync(result.backup!, 'utf8')).toBe('{ not json');
    expect(existsSync(file)).toBe(true);
    expect(store.state).toEqual({
      version: 1,
      repos: [],
      tasks: [],
      discardedCleanup: [],
    });
  });

  it('throws when neither rename nor copy can back up the corrupt file', async () => {
    const file = tmp();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV'), { code: 'EXDEV' }),
    );
    vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );
    const store = new TaskStore(file);
    await expect(store.load()).rejects.toThrow('could not be backed up');
  });

  it('serialises concurrent updates', async () => {
    const store = new TaskStore(tmp());
    await store.load();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.update((s) => {
          s.repos.push({
            id: `r${i}`,
            name: `n${i}`,
            path: `/p${i}`,
            baseBranch: 'main',
            connectionId: null,
            configFound: false,
            discovered: false,
            overrides: {},
            workItemOnStart: {
              moveToInProgress: true,
              assignToMe: true,
              stateOverrides: {},
            },
          });
        }),
      ),
    );
    expect(store.state.repos.map((r) => r.id).sort()).toEqual([
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
    ]);
  });
});
