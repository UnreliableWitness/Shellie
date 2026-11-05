import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempRepos, git, makeRepo } from '../test-helpers/gitRepo';
import { GitClient } from './GitClient';
import { RepoRegistry } from './RepoRegistry';
import { TaskStore } from './TaskStore';

/** Scratch folders this test creates itself (state dirs, non-git dirs), removed in afterAll. */
const scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
  cleanupTempRepos();
});

async function registry() {
  const store = new TaskStore(path.join(tempDir('shellie-reg-'), 'state.json'));
  await store.load();
  return new RepoRegistry(store, new GitClient());
}

describe('RepoRegistry', () => {
  it('registers a discovered repo with a connection, returns an existing one as is, and clears the mark', async () => {
    const reg = await registry();
    const repo = makeRepo('found');
    const added = await reg.addDiscovered(repo, 'c1');
    expect(added).toMatchObject({
      name: 'found',
      path: repo,
      connectionId: 'c1',
      discovered: true,
      overrides: {},
    });
    expect(await reg.addDiscovered(path.join(repo), null)).toEqual(added);
    expect(reg.list()).toHaveLength(1);
    const cleared = await reg.setDiscovered(added.id, false);
    expect(cleared.discovered).toBe(false);
    expect(reg.get(added.id).discovered).toBe(false);
  });

  it('returns the registered repo when addDiscovered meets one added by hand', async () => {
    const reg = await registry();
    const repo = makeRepo('mine');
    const added = await reg.add(repo);
    expect(await reg.addDiscovered(repo, 'c1')).toEqual(added);
  });

  it('adds a repo with its name, default base and .shellie.yml flag', async () => {
    const reg = await registry();
    const repo = makeRepo('webshop');
    const added = await reg.add(repo);
    expect(added).toMatchObject({
      name: 'webshop',
      path: repo,
      baseBranch: 'main',
      connectionId: null,
      configFound: false,
      discovered: false,
      overrides: {},
    });
    expect(added.workItemOnStart).toBeUndefined();
    expect(reg.list()).toHaveLength(1);
    expect(reg.get(added.id)).toEqual(added);
  });

  it('loads a repo without workItemOnStart', async () => {
    const dir = tempDir('shellie-reg-old-');
    const file = path.join(dir, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        repos: [
          {
            id: 'r1',
            name: 'old',
            path: '/src/old',
            baseBranch: 'main',
            connectionId: null,
            configFound: false,
            discovered: false,
            overrides: {},
          },
        ],
        tasks: [],
      }),
    );
    const store = new TaskStore(file);
    await store.load();
    const reg = new RepoRegistry(store, new GitClient());
    expect(reg.get('r1').workItemOnStart).toBeUndefined();
    expect(reg.get('r1').agentCommands).toBeUndefined();
  });

  it('setAgentCommands stores trimmed commands, drops empty ones and keeps them on refresh', async () => {
    const dir = tempDir('shellie-reg-cmd-');
    const file = path.join(dir, 'state.json');
    const store = new TaskStore(file);
    await store.load();
    const reg = new RepoRegistry(store, new GitClient());
    const added = await reg.add(makeRepo('commands'));
    expect(added.agentCommands).toBeUndefined();
    const updated = await reg.setAgentCommands(added.id, {
      claude: '  claude --permission-mode acceptEdits ',
      opencode: '   ',
    });
    expect(updated.agentCommands).toEqual({
      claude: 'claude --permission-mode acceptEdits',
    });
    const store2 = new TaskStore(file);
    await store2.load();
    const reg2 = new RepoRegistry(store2, new GitClient());
    expect((await reg2.refresh(added.id)).agentCommands).toEqual({
      claude: 'claude --permission-mode acceptEdits',
    });
    expect(
      (await reg2.setAgentCommands(added.id, { claude: '' })).agentCommands,
    ).toEqual({});
  });

  it('setWorkItemOnStart persists', async () => {
    const dir = tempDir('shellie-reg-set-');
    const file = path.join(dir, 'state.json');
    const store = new TaskStore(file);
    await store.load();
    const reg = new RepoRegistry(store, new GitClient());
    const added = await reg.add(makeRepo('settings'));
    const settings = {
      moveToInProgress: false,
      assignToMe: true,
      stateOverrides: { Task: 'Doing' },
    };
    const updated = await reg.setWorkItemOnStart(added.id, settings);
    expect(updated.workItemOnStart).toEqual(settings);
    const store2 = new TaskStore(file);
    await store2.load();
    const reg2 = new RepoRegistry(store2, new GitClient());
    expect(reg2.get(added.id).workItemOnStart).toEqual(settings);
    const refreshed = await reg2.refresh(added.id);
    expect(refreshed.workItemOnStart).toEqual(settings);
  });

  it('takes the base branch from .shellie.yml', async () => {
    const reg = await registry();
    const repo = makeRepo('api');
    writeFileSync(path.join(repo, '.shellie.yml'), 'base: develop\n');
    expect(await reg.add(repo)).toMatchObject({
      baseBranch: 'develop',
      configFound: true,
      discovered: false,
      overrides: {},
    });
  });

  it('normalises a subfolder and a symlink to the toplevel and rejects duplicates', async () => {
    const reg = await registry();
    const repo = makeRepo('webshop');
    mkdirSync(path.join(repo, 'src'));
    const link = path.join(path.dirname(repo), 'link');
    // A junction needs no privilege on Windows; the type argument is ignored elsewhere.
    symlinkSync(repo, link, 'junction');
    const first = await reg.add(path.join(repo, 'src'));
    expect(first.path).toBe(repo);
    await expect(reg.add(repo)).rejects.toThrow(/already/);
    await expect(reg.add(link)).rejects.toThrow(/already/);
    expect(reg.list()).toHaveLength(1);
  });

  it('rejects a folder that is not a git repository', async () => {
    const reg = await registry();
    await expect(reg.add(tempDir('shellie-notgit-'))).rejects.toThrow(
      /not a git repository/,
    );
  });

  it('rejects a folder that does not exist', async () => {
    const reg = await registry();
    await expect(
      reg.add(path.join(tempDir('shellie-missing-'), 'nope')),
    ).rejects.toThrow(/does not exist/);
  });

  it('rejects a concurrent duplicate add', async () => {
    const reg = await registry();
    const repo = makeRepo('webshop');
    const results = await Promise.allSettled([reg.add(repo), reg.add(repo)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/already/) }),
    );
    expect(reg.list()).toHaveLength(1);
  });

  it('removes a repo and refuses when it still has open tasks', async () => {
    const reg = await registry();
    const repo = await reg.add(makeRepo('webshop'));
    await reg.remove(repo.id);
    expect(reg.list()).toHaveLength(0);
    const again = await reg.add(makeRepo('webshop'));
    await (reg as unknown as { store: TaskStore }).store.update((s) => {
      s.tasks.push({
        id: 't1',
        repoId: again.id,
        name: 'x',
        workItem: null,
        slug: 'x',
        branch: 'b',
        worktreePath: '/w',
        baseRef: 'main',
        baseSha: null,
        openPeriods: [],
        time: null,
        status: 'ready',
        setup: {
          copy: false,
          commands: [],
          startClaude: false,
          openShell: false,
          openCopilot: false,
          summary: null,
        },
        terminals: [],
        createdAt: 'now',
        finishedAt: null,
        usageSyncedAt: null,
        usageSyncError: null,
        usageCommentId: null,
        summary: null,
        pullRequest: null,
        closedTerminals: [],
        reopen: null,
        extraWorkspaces: [],
        detachedPaths: [],
        homeDropped: false,
        connectionId: null,
        mainCheckoutEdits: [],
        environment: 'development',
        environmentUntil: null,
        pendingCleanup: [],
      });
    });
    await expect(reg.remove(again.id)).rejects.toThrow(/open task/);
  });

  it('links and unlinks a connection', async () => {
    const reg = await registry();
    const repo = await reg.add(makeRepo('webshop'));
    expect((await reg.setConnection(repo.id, 'c1')).connectionId).toBe('c1');
    expect(reg.get(repo.id).connectionId).toBe('c1');
    expect((await reg.setConnection(repo.id, null)).connectionId).toBeNull();
    await expect(reg.setConnection('nope', 'c1')).rejects.toThrow(
      /Unknown repo/,
    );
  });
});

describe('RepoRegistry.add options', () => {
  it('writes the given .shellie.yml first and registers with configFound', async () => {
    const reg = await registry();
    const repo = makeRepo('cfg');
    const text = 'base: develop\nbranch: "{type}/{id}-{slug}"\n';
    const added = await reg.add(repo, {
      writeConfig: text,
      connectionId: 'c1',
    });
    expect(readFileSync(path.join(repo, '.shellie.yml'), 'utf8')).toBe(text);
    expect(added).toMatchObject({
      configFound: true,
      baseBranch: 'develop',
      connectionId: 'c1',
    });
  });

  it('fails without registering when .shellie.yml already exists', async () => {
    const reg = await registry();
    const repo = makeRepo('has');
    writeFileSync(path.join(repo, '.shellie.yml'), 'base: x\n');
    await expect(reg.add(repo, { writeConfig: 'base: y\n' })).rejects.toThrow(
      '.shellie.yml already exists',
    );
    expect(readFileSync(path.join(repo, '.shellie.yml'), 'utf8')).toBe(
      'base: x\n',
    );
    expect(reg.list()).toHaveLength(0);
  });

  it('starts with the on-start options it is given', async () => {
    const reg = await registry();
    const options = {
      moveToInProgress: false,
      assignToMe: false,
      stateOverrides: {},
    };
    const added = await reg.add(makeRepo('onstart'), {
      connectionId: 'c1',
      workItemOnStart: options,
    });
    expect(added.workItemOnStart).toEqual(options);
    expect(reg.list()[0].workItemOnStart).toEqual(options);
  });

  it('keeps a given base branch across refresh when there is no file', async () => {
    const reg = await registry();
    const repo = makeRepo('nofile');
    git(repo, 'branch', 'develop');
    const added = await reg.add(repo, { baseBranch: 'develop' });
    expect(added).toMatchObject({ baseBranch: 'develop', configFound: false });
    expect((await reg.refresh(added.id)).baseBranch).toBe('develop');
    writeFileSync(path.join(repo, '.shellie.yml'), 'base: release\n');
    expect((await reg.refresh(added.id)).baseBranch).toBe('release');
  });

  it("a .shellie.yml's base wins over the inspected base branch", async () => {
    const reg = await registry();
    const repo = makeRepo('withfile');
    writeFileSync(path.join(repo, '.shellie.yml'), 'base: release\n');
    const added = await reg.add(repo, { baseBranch: 'develop' });
    expect(added).toMatchObject({ baseBranch: 'release', configFound: true });
  });

  it('corrects a stored base that no longer exists, and keeps one that does (#120)', async () => {
    const reg = await registry();
    const repo = makeRepo('old');
    git(repo, 'branch', '-m', 'master');
    const root = path.dirname(repo);
    git(root, 'init', '-q', '--bare', '-b', 'master', 'origin.git');
    git(repo, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
    git(repo, 'push', '-q', '-u', 'origin', 'master');
    git(repo, 'remote', 'set-head', 'origin', 'master');
    git(repo, 'push', '-q', 'origin', 'master:develop');
    git(repo, 'fetch', '-q', 'origin');
    // Registered before the fix: stored as main, which this repo does not have.
    const added = await reg.add(repo, { baseBranch: 'main' });
    expect(added.baseBranch).toBe('master');
    const stale = { ...added, baseBranch: 'main' };
    reg.list()[0] = stale;
    expect((await reg.refresh(added.id)).baseBranch).toBe('master');
    expect(reg.get(added.id).baseBranch).toBe('master');
    reg.list()[0] = { ...added, baseBranch: 'develop' };
    expect((await reg.refresh(added.id)).baseBranch).toBe('develop');
  });
  it('setOverride stores and null removes', async () => {
    const reg = await registry();
    const added = await reg.add(makeRepo('over'));
    const set = await reg.setOverride(added.id, 'setup', ['pnpm i']);
    expect(set.overrides).toEqual({ setup: ['pnpm i'] });
    await reg.setOverride(added.id, 'apm', false);
    expect(reg.get(added.id).overrides).toEqual({
      setup: ['pnpm i'],
      apm: false,
    });
    const removed = await reg.setOverride(added.id, 'setup', null);
    expect(removed.overrides).toEqual({ apm: false });
    expect((await reg.clearOverrides(added.id)).overrides).toEqual({});
  });

  it('refresh keeps overrides', async () => {
    const reg = await registry();
    const added = await reg.add(makeRepo('keep'));
    await reg.setOverride(added.id, 'branch', 'fix/{id}');
    expect((await reg.refresh(added.id)).overrides).toEqual({
      branch: 'fix/{id}',
    });
  });

  it('setOverride rejects a wrong type', async () => {
    const reg = await registry();
    const added = await reg.add(makeRepo('wrong'));
    await expect(
      reg.setOverride(added.id, 'setup', 'x' as unknown as string[]),
    ).rejects.toThrow();
    expect(reg.get(added.id).overrides).toEqual({});
  });
});
