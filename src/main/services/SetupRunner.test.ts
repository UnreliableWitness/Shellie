import {
  chmodSync,
  symlinkSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { SetupEvent } from '../../shared/types';
import {
  addOrigin,
  cleanupTempRepos,
  commitFile,
  git as gitCli,
  makeRepo,
} from '../test-helpers/gitRepo';
import {
  normaliseEol,
  sleepCmd,
  testPlatform,
  writeLineCmd,
} from '../test-helpers/shell';
import { GitAuthError, GitClient } from './GitClient';
import {
  ensureExcluded,
  planSteps,
  SetupRunner,
  type SetupPlan,
} from './SetupRunner';

afterAll(cleanupTempRepos);

// A step that hangs on the Windows runner fails within these deadlines, naming itself, before the test's 60 s (#148).
const git = new GitClient(undefined, { worktreeTimeoutMs: 30_000 });
const runner = new SetupRunner(git, testPlatform(), undefined, {
  commandTimeoutMs: 30_000,
});

function plan(repo: string, over: Partial<SetupPlan> = {}): SetupPlan {
  return {
    taskId: 'task1',
    repoPath: repo,
    worktreePath: path.join(path.dirname(repo), 'repo.worktrees', 'x'),
    branch: 'feature/x',
    baseRef: 'main',
    copy: [],
    commands: [],
    taskMd: '# Task\n',
    startTerminalsLabel: null,
    updateWorkItem: false,
    ...over,
  };
}

function collect() {
  const events: SetupEvent[] = [];
  return { events, onEvent: (e: SetupEvent) => events.push(e) };
}

describe('planSteps', () => {
  it('lists fetch, worktree, optional copy, clone, task file, apm and terminals', () => {
    const steps = planSteps(
      plan('/r', {
        copy: ['.env'],
        commands: ['npm ci', 'npm run build'],
        startTerminalsLabel: 'Claude Code, zsh',
        cloneNodeModules: true,
        apmTargets: ['claude', 'copilot'],
      }),
    );
    expect(steps.map((s) => s.kind)).toEqual([
      'fetch',
      'worktree',
      'copy',
      'node-modules',
      'task-file',
      'apm',
      'terminals',
    ]);
    expect(steps[3]).toEqual({
      kind: 'node-modules',
      label: 'Clone node_modules',
      detail: 'from r',
    });
    expect(steps[5]).toEqual({
      kind: 'apm',
      label: 'Install agent packages',
      detail: 'apm install --target claude, copilot',
    });
    expect(steps[6]).toEqual({
      kind: 'terminals',
      label: 'Start terminals',
      detail: 'Claude Code, zsh, Setup (npm ci, npm run build)',
    });
    expect(planSteps(plan('/r')).map((s) => s.kind)).toEqual([
      'fetch',
      'worktree',
      'task-file',
    ]);
  });

  it('starts terminals for the Setup tab alone when no tab was asked for', () => {
    const steps = planSteps(plan('/r', { commands: ['npm ci'] }));
    expect(steps.at(-1)).toEqual({
      kind: 'terminals',
      label: 'Start terminals',
      detail: 'Setup (npm ci)',
    });
    expect(
      planSteps(plan('/r', { apmTargets: [] })).map((s) => s.kind),
    ).not.toContain('apm');
  });

  it('puts the work item step right after the worktree when asked', () => {
    const steps = planSteps(plan('/r', { updateWorkItem: true }));
    expect(steps.map((s) => s.kind)).toEqual([
      'fetch',
      'worktree',
      'work-item',
      'task-file',
    ]);
    expect(steps[2]).toEqual({
      kind: 'work-item',
      label: 'Update work item',
      detail: 'Move to In Progress',
    });
    expect(
      planSteps(plan('/r', { updateWorkItem: false })).map((s) => s.kind),
    ).not.toContain('work-item');
  });
});

describe('SetupRunner: work item step', () => {
  const stepEvents = (events: SetupEvent[], index: number) =>
    events.filter((e) => e.type === 'step' && e.index === index);

  it('ends done with the hook detail', async () => {
    const repo = makeRepo();
    const { events, onEvent } = collect();
    const result = await runner.run(plan(repo, { updateWorkItem: true }), {
      onEvent,
      startTerminals: async () => {},
      updateWorkItem: async () => ({ detail: 'New → Doing', warn: false }),
    });
    expect(result).toEqual({ ok: true });
    expect(stepEvents(events, 2).at(-1)).toMatchObject({
      status: 'done',
      detail: 'New → Doing',
    });
  });

  it('ends as warn when the hook says so, and the later steps still run', async () => {
    const repo = makeRepo();
    const p = plan(repo, { updateWorkItem: true });
    const { events, onEvent } = collect();
    const detail =
      'The token cannot update work items (needs Work Items: Read & write)';
    const result = await runner.run(p, {
      onEvent,
      startTerminals: async () => {},
      updateWorkItem: async () => ({ detail, warn: true }),
    });
    expect(result).toEqual({ ok: true });
    expect(stepEvents(events, 2).at(-1)).toMatchObject({
      status: 'warn',
      detail,
    });
    expect(stepEvents(events, 3).at(-1)).toMatchObject({ status: 'done' });
    expect(existsSync(path.join(p.worktreePath, '.shellie', 'task.md'))).toBe(
      true,
    );
    expect(events.at(-1)).toEqual({
      taskId: 'task1',
      type: 'finished',
      ok: true,
    });
  });

  it('turns a throwing hook into a warn with the error message', async () => {
    const repo = makeRepo();
    const { events, onEvent } = collect();
    const result = await runner.run(plan(repo, { updateWorkItem: true }), {
      onEvent,
      startTerminals: async () => {},
      updateWorkItem: async () => {
        throw new Error('Azure DevOps is unreachable');
      },
    });
    expect(result).toEqual({ ok: true });
    expect(stepEvents(events, 2).at(-1)).toMatchObject({
      status: 'warn',
      detail: 'Azure DevOps is unreachable',
    });
    expect(
      events.some(
        (e) => e.type === 'log' && e.line === 'Azure DevOps is unreachable',
      ),
    ).toBe(true);
  });
});

describe('SetupRunner', () => {
  it('creates the worktree, copies files, writes the task file and starts terminals with the setup commands', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    writeFileSync(path.join(repo, '.env'), 'SECRET=1');
    const p = plan(repo, {
      baseRef: 'origin/main',
      copy: ['.env', '.env.local'],
      commands: ['npm ci', 'npm run build'],
      startTerminalsLabel: 'zsh',
    });
    const { events, onEvent } = collect();
    let started: string[] | null = null;
    const result = await runner.run(p, {
      onEvent,
      startTerminals: async (commands) => {
        started = commands;
      },
    });

    expect(result).toEqual({ ok: true });
    // No node_modules in the worktree: npm ci stays.
    expect(started).toEqual(['npm ci', 'npm run build']);
    expect(readFileSync(path.join(p.worktreePath, '.env'), 'utf8')).toBe(
      'SECRET=1',
    );
    expect(
      readFileSync(path.join(p.worktreePath, '.shellie', 'task.md'), 'utf8'),
    ).toBe('# Task\n');
    expect(
      readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'),
    ).toContain('.shellie/');
    expect(await git.summary(p.worktreePath, 'origin/main')).toMatchObject({
      files: [{ status: '?', path: '.env' }],
    });

    const stepEvents = events.filter((e) => e.type === 'step');
    expect(
      stepEvents.filter((e) => e.type === 'step' && e.status === 'done'),
    ).toHaveLength(5);
    expect(
      events.some(
        (e) => e.type === 'log' && e.line.includes('skipped .env.local'),
      ),
    ).toBe(true);
    expect(events.at(-1)).toEqual({
      taskId: 'task1',
      type: 'finished',
      ok: true,
    });
  });

  it('reuses an existing worktree and branch when run again from step 0', async () => {
    const repo = makeRepo();
    const p = plan(repo);
    const first = await runner.run(p, {
      onEvent: () => {},
      startTerminals: async () => {},
    });
    expect(first.ok).toBe(true);
    const { events, onEvent } = collect();
    const second = await runner.run(p, {
      onEvent,
      startTerminals: async () => {},
    });
    expect(second).toEqual({ ok: true });
    expect(
      events.some(
        (e) =>
          e.type === 'log' &&
          e.line === `worktree ${p.worktreePath} already exists, reusing it`,
      ),
    ).toBe(true);
    expect(existsSync(path.join(p.worktreePath, '.shellie', 'task.md'))).toBe(
      true,
    );
  });

  it('reports a git failure on the worktree step', async () => {
    const repo = makeRepo();
    const p = plan(repo, { baseRef: 'does-not-exist' });
    const { events, onEvent } = collect();
    const result = await runner.run(p, {
      onEvent,
      startTerminals: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe(1);
    const failed = events.find(
      (e) => e.type === 'step' && e.status === 'failed',
    );
    expect(failed).toMatchObject({
      index: 1,
      detail: expect.stringMatching(/invalid reference|not a valid|fatal/i),
    });
    expect(
      events.some(
        (e) =>
          e.type === 'log' &&
          !e.line.startsWith('$ git worktree add') &&
          /invalid reference|not a valid|fatal/i.test(e.line),
      ),
    ).toBe(true);
  });

  it('marks a fetch that could not sign in with where it failed', async () => {
    const repo = makeRepo();
    const g = new GitClient();
    const hint = { host: 'dev.azure.com', connectionId: 'c1', path: repo };
    vi.spyOn(g, 'fetch').mockRejectedValue(
      new GitAuthError(
        'git fetch --quiet origin main failed (128): fatal: could not read Password',
        'fatal: could not read Password',
        hint,
      ),
    );
    const { events, onEvent } = collect();
    const result = await new SetupRunner(g, testPlatform()).run(
      plan(repo, { baseRef: 'origin/main' }),
      { onEvent, startTerminals: async () => {} },
    );
    expect(result).toEqual({ ok: false, failedStep: 0 });
    expect(
      events.find((e) => e.type === 'step' && e.status === 'failed'),
    ).toMatchObject({ index: 0, auth: hint });
  });

  it('a failure that is not about signing in has no hint', async () => {
    const repo = makeRepo();
    const { events, onEvent } = collect();
    await runner.run(plan(repo, { baseRef: 'does-not-exist' }), {
      onEvent,
      startTerminals: async () => {},
    });
    const failed = events.find(
      (e) => e.type === 'step' && e.status === 'failed',
    );
    expect(failed && 'auth' in failed).toBe(false);
  });

  it('rejects a fromStep outside the plan', async () => {
    const repo = makeRepo();
    await expect(
      runner.run(plan(repo), {
        onEvent: () => {},
        startTerminals: async () => {},
        fromStep: 99,
      }),
    ).rejects.toThrow('Cannot retry from step 99: the plan has 3 steps');
  });

  it('skips copy entries that escape the repository or worktree', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, '.env'), 'SECRET=1');
    writeFileSync(path.join(path.dirname(repo), 'outside.txt'), 'x');
    const p = plan(repo, { copy: ['../outside.txt', '/etc/hosts', '.env'] });
    const { events, onEvent } = collect();
    const result = await runner.run(p, {
      onEvent,
      startTerminals: async () => {},
    });
    expect(result).toEqual({ ok: true });
    const lines = events.flatMap((e) => (e.type === 'log' ? [e.line] : []));
    expect(lines).toContain('skipped ../outside.txt (outside the repository)');
    expect(lines).toContain('skipped /etc/hosts (outside the repository)');
    expect(readFileSync(path.join(p.worktreePath, '.env'), 'utf8')).toBe(
      'SECRET=1',
    );
    expect(
      existsSync(path.join(path.dirname(p.worktreePath), 'outside.txt')),
    ).toBe(false);
    expect(existsSync(path.join(p.worktreePath, 'hosts'))).toBe(false);
  });
});

describe('SetupRunner: copied env files without stored secrets', () => {
  const run = async (names: string[], files: Record<string, string>) => {
    const repo = makeRepo();
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      writeFileSync(path.join(repo, f), text);
    }
    const asked: string[] = [];
    const r = new SetupRunner(git, testPlatform(), (repoId) => {
      asked.push(repoId);
      return names;
    });
    const p = plan(repo, { repoId: 'repo-1', copy: Object.keys(files) });
    await r.run(p, { ...collect(), startTerminals: async () => {} });
    return { p, asked };
  };
  const read = (p: SetupPlan, f: string) =>
    readFileSync(path.join(p.worktreePath, f), 'utf8');

  it('drops stored keys from a copied .env and keeps PORT and comments', async () => {
    const { p, asked } = await run(['API_KEY'], {
      '.env': '# local\nPORT=5000\nAPI_KEY=sk_live_abc\n',
    });
    expect(asked).toContain('repo-1');
    expect(read(p, '.env')).toBe('# local\nPORT=5000\n');
  });

  it('drops stored keys from copied JSON, also inside a copied folder', async () => {
    const { p } = await run(['ConnectionStrings__Db', 'TOKEN'], {
      'appsettings.Development.json':
        '{"ConnectionStrings":{"Db":"x"},"Port":1}',
      'secrets/.env.local': 'TOKEN=t\nKEEP=k\n',
    });
    expect(JSON.parse(read(p, 'appsettings.Development.json'))).toEqual({
      ConnectionStrings: {},
      Port: 1,
    });
    expect(read(p, 'secrets/.env.local')).toBe('KEEP=k\n');
  });

  it('rewrites a copied file through a temp file next to it', async () => {
    const spy = vi.spyOn(fsp, 'rename');
    const { p } = await run(['API_KEY'], {
      '.env': 'PORT=5000\nAPI_KEY=sk_live_abc\n',
    });
    const target = path.join(p.worktreePath, '.env');
    expect(
      spy.mock.calls.some(
        ([from, to]) =>
          String(to) === target &&
          path.basename(String(from)) === `.shellie-tmp-${process.pid}-.env`,
      ),
    ).toBe(true);
    spy.mockRestore();
  });

  it('leaves other copied JSON alone', async () => {
    const text = '{"TOKEN":"t","name":"x"}';
    const { p } = await run(['TOKEN', 'name'], {
      'config.json': text,
      'secrets/stripe.json': text,
    });
    expect(read(p, 'config.json')).toBe(text);
    expect(JSON.parse(read(p, 'secrets/stripe.json'))).toEqual({});
  });

  it('copies every file byte for byte with an empty store', async () => {
    const files = {
      '.env': '\uFEFFAPI_KEY=1\r\n# c\r\n',
      'appsettings.json': '{ "ConnectionStrings": { "Db": "x" } }',
    };
    const { p } = await run([], files);
    for (const [f, text] of Object.entries(files))
      expect(read(p, f)).toBe(text);
  });
});

describe('agent config copy', () => {
  async function runCopy(repo: string, over: Partial<SetupPlan> = {}) {
    const p = plan(repo, { copyAgentConfig: true, ...over });
    const { events, onEvent } = collect();
    const result = await runner.run(p, {
      onEvent,
      startTerminals: async () => {},
    });
    expect(result).toEqual({ ok: true });
    const lines = events.flatMap((e) => (e.type === 'log' ? [e.line] : []));
    return { p, lines };
  }

  it('copies untracked agent config files and folders', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, 'opencode.json'), '{"mcp":{}}');
    mkdirSync(path.join(repo, '.opencode', 'agent'), { recursive: true });
    writeFileSync(path.join(repo, '.opencode', 'agent', 'a.md'), 'agent');
    writeFileSync(path.join(repo, '.mcp.json'), '{}');
    const { p, lines } = await runCopy(repo);
    expect(
      readFileSync(path.join(p.worktreePath, 'opencode.json'), 'utf8'),
    ).toBe('{"mcp":{}}');
    expect(
      readFileSync(
        path.join(p.worktreePath, '.opencode', 'agent', 'a.md'),
        'utf8',
      ),
    ).toBe('agent');
    expect(existsSync(path.join(p.worktreePath, '.mcp.json'))).toBe(true);
    expect(lines).toContain('copied opencode.json (agent config)');
  });

  it('leaves tracked files to git', async () => {
    const repo = makeRepo();
    commitFile(repo, 'opencode.json', 'committed');
    writeFileSync(path.join(repo, 'opencode.json'), 'local edit');
    const { p, lines } = await runCopy(repo);
    expect(
      readFileSync(path.join(p.worktreePath, 'opencode.json'), 'utf8'),
    ).toBe('committed');
    expect(lines).not.toContain('copied opencode.json (agent config)');
  });

  it('copies nothing when copyAgentConfig is off', async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, 'opencode.json'), '{}');
    const { p } = await runCopy(repo, { copyAgentConfig: false });
    expect(existsSync(path.join(p.worktreePath, 'opencode.json'))).toBe(false);
  });

  it('skips a symbolic link, even one pointing outside the repository', async () => {
    const repo = makeRepo();
    const outside = path.join(path.dirname(repo), 'secret.json');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(repo, 'opencode.json'));
    const { p, lines } = await runCopy(repo);
    expect(existsSync(path.join(p.worktreePath, 'opencode.json'))).toBe(false);
    expect(lines).toContain('skipped opencode.json (symbolic link)');
  });
});

const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/a': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
      integrity: 'sha512-a',
    },
  },
});

/** Installs a fake node_modules in the repo whose hidden lockfile is `hidden`. */
function installNodeModules(repo: string, hidden: string) {
  const nm = path.join(repo, 'node_modules');
  mkdirSync(path.join(nm, 'a'), { recursive: true });
  writeFileSync(path.join(nm, 'a', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(path.join(nm, '.package-lock.json'), hidden);
}

/** The test platform with a folder clone that works everywhere (a plain recursive copy). */
const cloningRunner = new SetupRunner(git, {
  ...testPlatform(),
  cloneDir: (src, dest) => ({
    command: process.execPath,
    args: [
      '-e',
      'require("fs").cpSync(process.argv[1], process.argv[2], { recursive: true })',
      src,
      dest,
    ],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }),
});

describe('SetupRunner: node_modules clone', () => {
  const stepOf = (events: SetupEvent[], kind: number) =>
    events.filter((e) => e.type === 'step' && e.index === kind).at(-1);

  it('clones an up-to-date node_modules and leaves npm ci out of the Setup tab', async () => {
    const repo = makeRepo();
    commitFile(repo, 'package-lock.json', LOCK);
    installNodeModules(repo, LOCK);
    const p = plan(repo, {
      commands: ['npm ci', 'npm run build'],
      cloneNodeModules: true,
    });
    const { events, onEvent } = collect();
    let started: string[] | null = null;
    const result = await cloningRunner.run(p, {
      onEvent,
      startTerminals: async (c) => {
        started = c;
      },
    });
    expect(result).toEqual({ ok: true });
    expect(
      readFileSync(
        path.join(p.worktreePath, 'node_modules', 'a', 'index.js'),
        'utf8',
      ),
    ).toContain('module.exports');
    expect(
      existsSync(`${path.join(p.worktreePath, 'node_modules')}.shellie-clone`),
    ).toBe(false);
    expect(started).toEqual(['npm run build']);
    expect(stepOf(events, 2)).toMatchObject({
      status: 'done',
      detail: 'Cloned from repo, npm ci skipped',
    });
    expect(stepOf(events, 4)).toMatchObject({
      status: 'done',
      detail: 'Setup (npm run build)',
    });
  });

  it('does not clone an out-of-date node_modules, so npm ci runs', async () => {
    const repo = makeRepo();
    commitFile(repo, 'package-lock.json', LOCK);
    installNodeModules(repo, LOCK.replace('1.0.0', '0.9.0'));
    const p = plan(repo, { commands: ['npm ci'], cloneNodeModules: true });
    const { events, onEvent } = collect();
    let started: string[] | null = null;
    await cloningRunner.run(p, {
      onEvent,
      startTerminals: async (c) => {
        started = c;
      },
    });
    expect(existsSync(path.join(p.worktreePath, 'node_modules'))).toBe(false);
    expect(started).toEqual(['npm ci']);
    expect(stepOf(events, 2)).toMatchObject({
      status: 'done',
      detail: expect.stringContaining('out of date, npm ci installs'),
    });
  });

  it('warns and leaves no partial clone when the clone fails', async () => {
    const repo = makeRepo();
    commitFile(repo, 'package-lock.json', LOCK);
    installNodeModules(repo, LOCK);
    const failing = new SetupRunner(git, {
      ...testPlatform(),
      cloneDir: () => ({
        command: process.execPath,
        args: ['-e', 'process.exit(4)'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }),
    });
    const p = plan(repo, { commands: ['npm ci'], cloneNodeModules: true });
    const { events, onEvent } = collect();
    let started: string[] | null = null;
    const result = await failing.run(p, {
      onEvent,
      startTerminals: async (c) => {
        started = c;
      },
    });
    expect(result).toEqual({ ok: true });
    expect(stepOf(events, 2)).toMatchObject({ status: 'warn' });
    expect(existsSync(path.join(p.worktreePath, 'node_modules'))).toBe(false);
    expect(started).toEqual(['npm ci']);
  });
});

/** A fake `apm` on the PATH: logs its arguments, fails `--version` when missing, fails one target on request. */
function fakeApm(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'apm'),
    [
      '#!/bin/sh',
      '[ -n "$FAKE_APM_MISSING" ] && exit 127',
      'echo "$*" >> "$FAKE_APM_LOG"',
      'if [ -n "$FAKE_APM_TOUCH" ] && [ "$1" = "install" ]; then echo "$3" >> apm.lock.yaml; mkdir -p .claude; echo deployed > .claude/deployed.md; fi',
      'if [ -n "$FAKE_APM_FAIL" ] && [ "$3" = "$FAKE_APM_FAIL" ]; then echo "install failed" >&2; exit 2; fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(path.join(dir, 'apm'), 0o755);
  writeFileSync(
    path.join(dir, 'apm.cmd'),
    [
      '@echo off',
      'if defined FAKE_APM_MISSING exit /b 127',
      'echo %*>> "%FAKE_APM_LOG%"',
      'if defined FAKE_APM_TOUCH if "%1"=="install" (echo %3>> apm.lock.yaml & if not exist .claude mkdir .claude & echo deployed> .claude\\deployed.md)',
      'if defined FAKE_APM_FAIL if "%3"=="%FAKE_APM_FAIL%" (echo install failed 1>&2 & exit /b 2)',
      'exit /b 0',
      '',
    ].join('\r\n'),
  );
}

describe('SetupRunner: apm step', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of [
      'PATH',
      'FAKE_APM_LOG',
      'FAKE_APM_MISSING',
      'FAKE_APM_FAIL',
      'FAKE_APM_TOUCH',
    ])
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  });

  const setup = (env: Record<string, string> = {}) => {
    const repo = makeRepo();
    commitFile(repo, 'apm.yml', 'name: test\n');
    const bin = path.join(path.dirname(repo), 'bin');
    fakeApm(bin);
    const log = path.join(path.dirname(repo), 'apm.log');
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
    process.env.FAKE_APM_LOG = log;
    Object.assign(process.env, env);
    const p = plan(repo, { apmTargets: ['claude', 'copilot'] });
    const calls = () =>
      existsSync(log)
        ? normaliseEol(readFileSync(log, 'utf8'))
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    return { p, calls };
  };
  const apmStep = (events: SetupEvent[]) =>
    events.filter((e) => e.type === 'step' && e.index === 3).at(-1);

  it('runs apm install once per target in the worktree', async () => {
    const { p, calls } = setup();
    const { events, onEvent } = collect();
    const result = await runner.run(p, {
      onEvent,
      startTerminals: async () => {},
    });
    expect(result).toEqual({ ok: true });
    expect(calls()).toEqual([
      '--version',
      'install --target claude',
      'install --target copilot',
    ]);
    expect(apmStep(events)).toMatchObject({
      status: 'done',
      detail: 'Installed for claude, copilot',
    });
  });

  it('keeps committed files apm install rewrites as committed, and what it deployed (#74)', async () => {
    const { p } = setup({ FAKE_APM_TOUCH: '1' });
    commitFile(p.repoPath, 'apm.lock.yaml', 'lock: 1\n');
    const { events, onEvent } = collect();
    const result = await runner.run(p, {
      onEvent,
      startTerminals: async () => {},
    });
    expect(result).toEqual({ ok: true });
    expect(
      normaliseEol(
        readFileSync(path.join(p.worktreePath, 'apm.lock.yaml'), 'utf8'),
      ),
    ).toBe('lock: 1\n');
    expect(
      existsSync(path.join(p.worktreePath, '.claude', 'deployed.md')),
    ).toBe(true);
    expect(apmStep(events)).toMatchObject({
      status: 'done',
      detail: 'Installed for claude, copilot; kept apm.lock.yaml as committed',
    });
  });

  it('warns and goes on when apm is not installed', async () => {
    const { p, calls } = setup({ FAKE_APM_MISSING: '1' });
    const { events, onEvent } = collect();
    const result = await runner.run(p, {
      onEvent,
      startTerminals: async () => {},
    });
    expect(result).toEqual({ ok: true });
    expect(calls()).toEqual([]);
    expect(apmStep(events)).toMatchObject({
      status: 'warn',
      detail: 'apm is not installed, skipped',
    });
  });

  it('fails the step when an install fails, and a retry runs it again', async () => {
    const { p } = setup({ FAKE_APM_FAIL: 'copilot' });
    const first = await runner.run(p, {
      onEvent: () => {},
      startTerminals: async () => {},
    });
    expect(first).toEqual({ ok: false, failedStep: 3 });
    delete process.env.FAKE_APM_FAIL;
    const { events, onEvent } = collect();
    const retry = await runner.run(p, {
      onEvent,
      startTerminals: async () => {},
      fromStep: 3,
    });
    expect(retry).toEqual({ ok: true });
    expect(apmStep(events)).toMatchObject({ status: 'done' });
  });

  it('skips quietly when the worktree has no apm.yml', async () => {
    const repo = makeRepo();
    const { events, onEvent } = collect();
    await runner.run(plan(repo, { apmTargets: ['claude'] }), {
      onEvent,
      startTerminals: async () => {},
    });
    expect(apmStep(events)).toMatchObject({
      status: 'done',
      detail: 'No apm.yml in the worktree',
    });
  });
});

describe('ensureExcluded', () => {
  it('adds the pattern exactly once under concurrent calls', async () => {
    const repo = makeRepo();
    await Promise.all(
      Array.from({ length: 5 }, () => ensureExcluded(git, repo, '.shellie/')),
    );
    const text = readFileSync(
      path.join(repo, '.git', 'info', 'exclude'),
      'utf8',
    );
    expect(
      text.split('\n').filter((l) => l.trim() === '.shellie/'),
    ).toHaveLength(1);
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('SetupRunner: reopen with more repos', () => {
  const extra = (
    over: Partial<NonNullable<SetupPlan['extraRestores']>[number]> = {},
  ) => ({
    workspaceId: 'w2',
    repoName: 'api',
    repoPath: '/api',
    worktreePath: '/api-wt',
    branch: 'feature/x',
    from: null,
    copy: [],
    commands: [],
    ...over,
  });

  it('lists each extra repo after the home and before the terminals', () => {
    const steps = planSteps(
      plan('/r', {
        restore: { from: null },
        commands: ['npm ci'],
        startTerminalsLabel: 'Claude Code',
        extraRestores: [
          extra({
            from: 'origin/feature/x',
            copy: ['.env'],
            commands: ['dotnet restore'],
          }),
          extra({ workspaceId: 'w3', repoName: 'docs', commands: ['make'] }),
        ],
      }),
    );
    expect(
      steps.map((s) => [s.kind, s.label, s.detail, s.workspaceId]),
    ).toEqual([
      ['worktree', 'Restore worktree', 'feature/x', undefined],
      ['task-file', 'Write task file', '.shellie/task.md', undefined],
      [
        'worktree',
        'Restore api worktree',
        'feature/x from origin/feature/x',
        'w2',
      ],
      ['copy', 'Copy local files (api)', '.env', 'w2'],
      ['command', 'dotnet restore', 'in api', 'w2'],
      ['worktree', 'Restore docs worktree', 'feature/x', 'w3'],
      ['command', 'make', 'in docs', 'w3'],
      [
        'terminals',
        'Restore terminals',
        'Claude Code, Setup (npm ci)',
        undefined,
      ],
    ]);
  });

  it('skips every home step when the home is not restored', () => {
    const steps = planSteps(
      plan('/r', {
        restore: { from: null },
        skipHome: true,
        copy: ['.env'],
        commands: ['npm ci'],
        startTerminalsLabel: 'Claude Code',
        extraRestores: [extra()],
      }),
    );
    expect(steps.map((s) => [s.kind, s.label, s.detail])).toEqual([
      ['worktree', 'Restore api worktree', 'feature/x'],
      ['terminals', 'Restore terminals', 'Claude Code'],
    ]);
  });

  it('opens no Setup tab for a home that is not restored', async () => {
    const home = makeRepo();
    let commands: string[] | null = null;
    const result = await runner.run(
      plan(home, {
        restore: { from: null },
        skipHome: true,
        commands: ['npm ci'],
        startTerminalsLabel: 'Claude Code',
      }),
      {
        onEvent: () => {},
        startTerminals: async (c) => {
          commands = c;
        },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(commands).toEqual([]);
  });

  it('restores an extra worktree from origin/<branch> and runs its commands there', async () => {
    const home = makeRepo();
    const api = makeRepo('api');
    addOrigin(api);
    const wt = path.join(path.dirname(api), 'api-wt');
    git_(api, 'worktree', 'add', '-q', '-b', 'feature/x', wt, 'main');
    writeFileSync(path.join(wt, 'work.txt'), 'w\n');
    git_(wt, 'add', 'work.txt');
    git_(wt, 'commit', '-q', '-m', 'work');
    git_(wt, 'push', '-q', 'origin', 'feature/x');
    git_(api, 'worktree', 'remove', '--force', wt);
    git_(api, 'branch', '-q', '-D', 'feature/x');
    git_(api, 'fetch', '-q', 'origin');
    writeFileSync(path.join(api, '.env'), 'API=1');
    const p = plan(home, {
      restore: { from: 'main' },
      startTerminalsLabel: 'zsh',
      extraRestores: [
        {
          workspaceId: 'w2',
          repoName: 'api',
          repoPath: api,
          worktreePath: wt,
          branch: 'feature/x',
          from: 'origin/feature/x',
          copy: ['.env'],
          commands: [writeLineCmd('restored', 'built.txt')],
        },
      ],
    });
    const { onEvent } = collect();
    let started = false;
    const result = await runner.run(p, {
      onEvent,
      startTerminals: async () => {
        started = true;
      },
    });
    expect(result).toEqual({ ok: true });
    expect(started).toBe(true);
    expect(existsSync(path.join(p.worktreePath, '.shellie', 'task.md'))).toBe(
      true,
    );
    expect(readFileSync(path.join(wt, 'work.txt'), 'utf8')).toBe('w\n');
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('API=1');
    expect(readFileSync(path.join(wt, 'built.txt'), 'utf8').trim()).toBe(
      'restored',
    );
    expect(existsSync(path.join(p.worktreePath, 'built.txt'))).toBe(false);
    expect(await git.branchExists(api, 'feature/x')).toBe(true);
  });

  it('fails a setup command that outlives its deadline, naming it (#148)', async () => {
    const home = makeRepo();
    const api = makeRepo('api');
    const cmd = sleepCmd(30);
    const { events, onEvent } = collect();
    const started = Date.now();
    const result = await new SetupRunner(git, testPlatform(), undefined, {
      commandTimeoutMs: 500,
    }).run(
      plan(home, {
        restore: { from: 'main' },
        skipHome: true,
        extraRestores: [
          {
            workspaceId: 'w2',
            repoName: 'api',
            repoPath: api,
            worktreePath: path.join(path.dirname(api), 'api-wt'),
            branch: 'feature/x',
            from: 'main',
            copy: [],
            commands: [cmd],
          },
        ],
      }),
      { onEvent, startTerminals: async () => {} },
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toEqual({ ok: false, failedStep: 1 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'step',
        index: 1,
        status: 'failed',
        detail: `${cmd} timed out after 0.5 s`,
      }),
    );
    expect(events).toContainEqual({
      taskId: 'task1',
      type: 'log',
      line: `${cmd} timed out after 0.5 s`,
    });
  });

  it('fails at the extra worktree step and a retry resumes there', async () => {
    const home = makeRepo();
    const api = makeRepo('api');
    const wt = path.join(path.dirname(api), 'api-wt');
    const restore = {
      workspaceId: 'w2',
      repoName: 'api',
      repoPath: api,
      worktreePath: wt,
      branch: 'feature/x',
      from: 'does-not-exist',
      copy: [],
      commands: [],
    };
    const p = plan(home, {
      restore: { from: 'main' },
      extraRestores: [restore],
    });
    const failed = await runner.run(p, {
      onEvent: () => {},
      startTerminals: async () => {},
    });
    expect(failed).toEqual({ ok: false, failedStep: 2 });
    const { events, onEvent } = collect();
    const retried = await runner.run(
      { ...p, extraRestores: [{ ...restore, from: 'main' }] },
      { onEvent, startTerminals: async () => {}, fromStep: 2 },
    );
    expect(retried).toEqual({ ok: true });
    expect(existsSync(wt)).toBe(true);
    expect(
      events.some((e) => e.type === 'log' && e.line.includes('reusing it')),
    ).toBe(false);
  });
});

function git_(cwd: string, ...args: string[]) {
  return gitCli(cwd, ...args);
}
