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
import {
  TaskSchema,
  type Connection,
  type Task,
  type TerminalDef,
} from '../../shared/types';
import { GitClient } from '../services/GitClient';
import { RepoRegistry } from '../services/RepoRegistry';
import { TaskStore } from '../services/TaskStore';
import { cleanupTempRepos, git, makeRepo } from '../test-helpers/gitRepo';
import { WorkspaceDetector } from './WorkspaceDetector';

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

const BRANCH = 'feature/42-thing';
const SESSION = '11111111-2222-3333-4444-555555555555';

const connection = (
  id: string,
  organizationUrl: string,
  project: string,
): Connection => ({
  id,
  name: id,
  organizationUrl,
  project,
  user: null,
  status: 'ok',
  checkedAt: null,
  userUniqueName: null,
  provider: 'azure-devops' as const,
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
});

function worktree(repo: string, branch: string, name = 'wt'): string {
  const wt = path.join(path.dirname(repo), name);
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt);
  return realpathSync.native(wt);
}

/** One JSONL line of an assistant tool_use, as Claude Code writes it. */
const toolLine = (cwd: string, name: string, input: unknown) =>
  JSON.stringify({
    type: 'assistant',
    cwd,
    message: { content: [{ type: 'tool_use', name, input }] },
  });

async function setup(
  opts: { terminals?: TerminalDef[]; closedTerminals?: TerminalDef[] } = {},
) {
  const store = new TaskStore(path.join(tempDir('shellie-det-'), 'state.json'));
  await store.load();
  const client = new GitClient();
  const repos = new RepoRegistry(store, client);
  const home = makeRepo('home');
  const homeRepo = await repos.add(home);
  const homeWt = worktree(home, BRANCH);
  const task: Task = TaskSchema.parse({
    id: 't1',
    repoId: homeRepo.id,
    name: 'n',
    workItem: null,
    slug: 's',
    branch: BRANCH,
    worktreePath: homeWt,
    baseRef: 'main',
    status: 'ready',
    setup: { copy: true, commands: [], startClaude: true, openShell: true },
    terminals: opts.terminals ?? [
      { id: 'c1', kind: 'claude', label: 'Claude', sessionId: SESSION },
      { id: 's1', kind: 'shell', label: 'Shell' },
    ],
    closedTerminals: opts.closedTerminals ?? [],
    createdAt: '2026-10-16T00:00:00.000Z',
    finishedAt: null,
  });
  await store.update((s) => {
    s.tasks.push(task);
  });
  const projectsDir = tempDir('shellie-projects-');
  const sessionDir = path.join(projectsDir, 'some-folder');
  mkdirSync(sessionDir);
  const sessionFile = path.join(sessionDir, `${SESSION}.jsonl`);
  writeFileSync(sessionFile, '');
  const log = (...lines: string[]) =>
    writeFileSync(sessionFile, lines.map((l) => `${l}\n`).join(''), {
      flag: 'a',
    });
  const notices: string[] = [];
  const events: { name: string; props?: Record<string, unknown> }[] = [];
  const connections = [
    connection('other', 'https://dev.azure.com/fabrikam', 'X'),
    connection('contoso', 'https://dev.azure.com/contoso', 'Web'),
  ];
  const detector = new WorkspaceDetector({
    store,
    git: client,
    repos,
    connections: () => connections,
    projectsDir: () => projectsDir,
    notice: (m) => notices.push(m),
    event: (name, props) => events.push({ name, props }),
  });
  const taskNow = () => store.state.tasks.find((t) => t.id === 't1')!;
  return {
    store,
    repos,
    detector,
    home,
    homeWt,
    projectsDir,
    log,
    notices,
    events,
    taskNow,
  };
}

/** Repo B with an Azure Repos origin URL (no push needed), outside the scan set. */
function repoB(name = 'b'): string {
  const b = makeRepo(name);
  git(
    b,
    'remote',
    'add',
    'origin',
    `https://dev.azure.com/contoso/Web/_git/${name}`,
  );
  return b;
}

describe('WorkspaceDetector.scan', () => {
  it('joins a worktree Claude edited in another repo and registers it as discovered', async () => {
    const env = await setup();
    const b = repoB();
    const bWt = worktree(b, 'feature/other-name');
    env.log(
      toolLine(env.homeWt, 'Edit', { file_path: path.join(bWt, 'README.md') }),
    );

    const { added } = await env.detector.scan('t1');

    expect(added).toHaveLength(1);
    const bRepo = env.repos.list().find((r) => r.path === b)!;
    expect(bRepo).toMatchObject({ discovered: true, connectionId: 'contoso' });
    expect(added[0]).toMatchObject({
      repoId: bRepo.id,
      branch: 'feature/other-name',
      worktreePath: bWt,
      baseRef: 'main',
      baseSha: git(b, 'rev-parse', 'main').trim(),
      source: 'detected',
    });
    expect(env.taskNow().extraWorkspaces).toEqual(added);
    expect(env.notices).toEqual(['Added b to this task']);
    expect(env.events).toEqual([
      { name: 'workspace.joined', props: { source: 'log' } },
    ]);

    // Nothing new in the log: a second scan adds nothing.
    expect((await env.detector.scan('t1')).added).toEqual([]);
    expect(env.taskNow().extraWorkspaces).toHaveLength(1);
    expect(env.notices).toHaveLength(1);
  });

  it('does not re-add a worktree after a fresh reader sees the same log again', async () => {
    const env = await setup();
    const bWt = worktree(repoB(), 'x');
    env.log(
      toolLine(env.homeWt, 'Write', { file_path: path.join(bWt, 'n.md') }),
    );
    await env.detector.scan('t1');
    const again = new WorkspaceDetector({
      store: env.store,
      git: new GitClient(),
      repos: env.repos,
      connections: () => [],
      projectsDir: () => env.projectsDir,
      notice: () => undefined,
      event: () => undefined,
    });
    expect((await again.scan('t1')).added).toEqual([]);
  });

  it('adds nothing for a session that only read another repo', async () => {
    const env = await setup();
    const bWt = worktree(repoB(), 'x');
    env.log(
      toolLine(env.homeWt, 'Read', { file_path: path.join(bWt, 'README.md') }),
      toolLine(env.homeWt, 'Grep', { pattern: 'a', path: bWt }),
      toolLine(env.homeWt, 'Bash', { command: `git -C "${bWt}" log` }),
    );
    expect((await env.detector.scan('t1')).added).toEqual([]);
    expect(env.taskNow().extraWorkspaces).toEqual([]);
  });

  it('ignores commits in the home worktree itself', async () => {
    const env = await setup();
    env.log(
      toolLine(env.homeWt, 'Bash', { command: 'git commit -am x' }),
      toolLine(env.homeWt, 'Edit', {
        file_path: path.join(env.homeWt, 'README.md'),
      }),
    );
    expect((await env.detector.scan('t1')).added).toEqual([]);
  });

  it('ignores a write to a folder that is not a git repo', async () => {
    const env = await setup();
    const plain = tempDir('shellie-plain-');
    env.log(
      toolLine(env.homeWt, 'Write', {
        file_path: path.join(plain, 'notes.md'),
      }),
    );
    expect((await env.detector.scan('t1')).added).toEqual([]);
    expect(env.taskNow().extraWorkspaces).toEqual([]);
    expect(env.repos.list()).toHaveLength(1);
  });

  it('reads the logs of closed Claude tabs too, and skips tabs without a session id', async () => {
    const env = await setup({
      terminals: [{ id: 'c0', kind: 'claude', label: 'Claude' }],
      closedTerminals: [
        { id: 'c1', kind: 'claude', label: 'Claude', sessionId: SESSION },
      ],
    });
    const bWt = worktree(repoB(), 'x');
    env.log(toolLine(env.homeWt, 'Edit', { file_path: path.join(bWt, 'a') }));
    expect((await env.detector.scan('t1')).added).toHaveLength(1);
  });

  it('joins a worktree of a registered repo on the task branch without any log', async () => {
    const env = await setup({ terminals: [] });
    const c = makeRepo('c');
    const cRepo = await env.repos.add(c);
    const cWt = worktree(c, BRANCH);

    const { added } = await env.detector.scan('t1');

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      repoId: cRepo.id,
      branch: BRANCH,
      worktreePath: cWt,
      source: 'detected',
    });
    expect(env.repos.get(cRepo.id).discovered).toBe(false);
    expect(env.events).toEqual([
      { name: 'workspace.joined', props: { source: 'branch' } },
    ]);
  });

  it('records an edit in a main checkout once and joins nothing', async () => {
    const env = await setup();
    const b = repoB();
    env.log(
      toolLine(env.homeWt, 'Edit', { file_path: path.join(b, 'README.md') }),
      toolLine(env.homeWt, 'Bash', { command: `git -C "${b}" commit -am x` }),
    );
    expect((await env.detector.scan('t1')).added).toEqual([]);
    env.log(toolLine(env.homeWt, 'Edit', { file_path: path.join(b, 'x') }));
    await env.detector.scan('t1');
    expect(env.taskNow().mainCheckoutEdits).toEqual([
      { repoPath: b, branch: 'main' },
    ]);
    expect(env.taskNow().extraWorkspaces).toEqual([]);
    expect(env.repos.list()).toHaveLength(1);
  });

  it('does not attach a worktree owned by another open task, even on the same branch name', async () => {
    const env = await setup({ terminals: [] });
    const c = makeRepo('c');
    const cRepo = await env.repos.add(c);
    const cWt = worktree(c, BRANCH);
    await env.store.update((s) => {
      s.tasks.push({
        ...structuredClone(s.tasks[0]),
        id: 't2',
        repoId: cRepo.id,
        worktreePath: cWt,
      });
    });
    expect((await env.detector.scan('t1')).added).toEqual([]);
  });

  it('shares one scan between concurrent calls', async () => {
    const env = await setup();
    const bWt = worktree(repoB(), 'x');
    env.log(toolLine(env.homeWt, 'Edit', { file_path: path.join(bWt, 'a') }));
    const [a, b] = await Promise.all([
      env.detector.scan('t1'),
      env.detector.scan('t1'),
    ]);
    expect(a).toBe(b);
    expect(env.taskNow().extraWorkspaces).toHaveLength(1);
  });

  it('does not re-add a workspace the user removed', async () => {
    const env = await setup({ terminals: [] });
    const c = makeRepo('c');
    await env.repos.add(c);
    const cWt = worktree(c, BRANCH);
    const [w] = (await env.detector.scan('t1')).added;

    await env.detector.remove('t1', w.id);

    expect(env.taskNow().extraWorkspaces).toEqual([]);
    expect(env.taskNow().detachedPaths).toEqual([cWt]);
    expect((await env.detector.scan('t1')).added).toEqual([]);
    expect(env.events.at(-1)).toEqual({ name: 'workspace.removed' });
  });
});

describe('WorkspaceDetector: only a ready task joins', () => {
  it('joins nothing while the task is finishing or setting up, and add refuses', async () => {
    for (const status of ['finishing', 'setting-up'] as const) {
      const env = await setup({ terminals: [] });
      const c = makeRepo('c');
      await env.repos.add(c);
      const cWt = worktree(c, BRANCH);
      await env.store.update((s) => {
        s.tasks[0].status = status;
      });
      expect((await env.detector.scan('t1')).added).toEqual([]);
      await expect(env.detector.add('t1', cWt)).rejects.toThrow(
        `Cannot add a worktree to a task that is ${status}`,
      );
      expect(env.taskNow().extraWorkspaces).toEqual([]);
    }
  });

  it('does not join when the task leaves ready while the join is under way', async () => {
    const env = await setup({ terminals: [] });
    const c = makeRepo('c');
    await env.repos.add(c);
    worktree(c, BRANCH);
    const real = env.repos.addDiscovered.bind(env.repos);
    vi.spyOn(env.repos, 'addDiscovered').mockImplementation(async (...a) => {
      await env.store.update((s) => {
        s.tasks[0].status = 'finishing';
      });
      return real(...a);
    });
    expect((await env.detector.scan('t1')).added).toEqual([]);
    expect(env.taskNow().extraWorkspaces).toEqual([]);
    expect(env.notices).toEqual([]);
  });
});

describe('WorkspaceDetector: a failing candidate', () => {
  it('is skipped with a warning; the other candidates still join', async () => {
    const env = await setup();
    const b = repoB();
    const bWt = worktree(b, 'x');
    env.log(toolLine(env.homeWt, 'Edit', { file_path: path.join(bWt, 'a') }));
    const c = makeRepo('c');
    await env.repos.add(c);
    const cWt = worktree(c, BRANCH);
    const real = env.repos.addDiscovered.bind(env.repos);
    vi.spyOn(env.repos, 'addDiscovered').mockImplementation(
      async (repoPath, ...rest) => {
        if (realpathSync.native(repoPath) === realpathSync.native(b))
          throw new Error('bare repo');
        return real(repoPath, ...rest);
      },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { added } = await env.detector.scan('t1');
    expect(added.map((w) => w.worktreePath)).toEqual([cWt]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('WorkspaceDetector.add and remove', () => {
  it('adds a worktree by hand, also one removed before', async () => {
    const env = await setup({ terminals: [] });
    const bWt = worktree(repoB(), 'x');
    const w = await env.detector.add('t1', bWt);
    expect(w).toMatchObject({
      worktreePath: bWt,
      branch: 'x',
      source: 'manual',
    });
    await env.detector.remove('t1', w.id);
    const back = await env.detector.add('t1', path.join(bWt, 'README.md'));
    expect(back.worktreePath).toBe(bWt);
    expect(env.taskNow().detachedPaths).toEqual([]);
    expect(env.events.map((e) => e.props?.source ?? e.name)).toEqual([
      'manual',
      'workspace.removed',
      'manual',
    ]);
  });

  it('refuses a main checkout, a non-repo folder and the home worktree', async () => {
    const env = await setup({ terminals: [] });
    const b = repoB();
    await expect(env.detector.add('t1', b)).rejects.toThrow(
      'b is the main checkout; pick a worktree',
    );
    await expect(
      env.detector.add('t1', tempDir('shellie-plain-')),
    ).rejects.toThrow(/not in a git repository/);
    await expect(env.detector.add('t1', env.homeWt)).rejects.toThrow(
      /already in this task/,
    );
    expect(env.taskNow().extraWorkspaces).toEqual([]);
  });

  it('refuses to remove the home workspace', async () => {
    const env = await setup({ terminals: [] });
    await expect(env.detector.remove('t1', 'home')).rejects.toThrow(
      /home workspace/,
    );
  });
});
