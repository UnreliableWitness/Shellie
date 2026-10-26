// handlers tests, part 2 of 6 (split so CI can run them on several machines at once).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../shared/types';
import {
  spawnFailure,
  type TerminalFailure,
  type TerminalKind,
} from '../../shared/terminalFailure';
import { fakeCrypto } from '../test-helpers/fakeCrypto';
import { GitClient } from '../services/GitClient';
import { loadShellieConfig } from '../services/ShellieConfig';
import { TaskStore } from '../services/TaskStore';
import { TerminalManager } from '../services/TerminalManager';
import { addOrigin, commitFile, git, makeRepo } from '../test-helpers/gitRepo';
import {
  echoCmd,
  failCmd,
  sleepCmd,
  testPlatform,
  writeLineCmd,
} from '../test-helpers/shell';
import { createHandlers, type Services } from './handlers';
import { allTerminals, harness } from './handlersHarness';

describe('handlers: terminals', () => {
  it('opens a run terminal, exposes its buffer, restarts and kills it', async () => {
    const { h, input, setupDone, terminals, store } = await harness();
    const done = setupDone();
    const t = await h['tasks:create'](input({ openShell: false }));
    await done;
    const def = await h['terminals:open'](t.id, {
      kind: 'run',
      label: 'dev',
      command: `${echoCmd('dev-server-up')}; ${sleepCmd(30)}`,
    });
    expect(store.state.tasks[0].terminals.map((x) => x.id)).toContain(def.id);
    await vi.waitFor(
      async () =>
        expect(await h['terminals:buffer'](def.id)).toContain('dev-server-up'),
      { timeout: 10_000 },
    );
    expect(await h['terminals:isRunning'](def.id)).toBe(true);
    await h['terminals:restart'](def.id);
    expect(await h['terminals:isRunning'](def.id)).toBe(true);
    await h['terminals:kill'](def.id);
    expect(store.state.tasks[0].terminals.map((x) => x.id)).not.toContain(
      def.id,
    );
    expect(terminals.runningCount(t.id)).toBe(0);
  });
});

describe('handlers: Claude Code sessions', () => {
  const recording = () => {
    const base = testPlatform();
    const calls: { prompt: string | null; flags: string[] }[] = [];
    const platform = {
      ...base,
      // A shell that exits at once stands in for claude.
      claudeCommand: (prompt: string | null, flags: string[] = []) => {
        calls.push({ prompt, flags });
        return base.runCommand(echoCmd('claude'));
      },
    };
    return { platform, calls };
  };

  it('starts Claude Code with the task as context and its own session id, and resumes it on restart', async () => {
    const { platform, calls } = recording();
    const hx = await harness(fakeCrypto(), {
      platform,
      claudeSessionExists: () => true,
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ openShell: false, startClaude: true }),
    );
    await done;
    const def = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'claude',
    );
    expect(def?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toEqual([
      {
        prompt: expect.stringMatching(
          /\.shellie\/task\.md\. Do not start on the task by yourself/,
        ),
        flags: ['--session-id', def?.sessionId],
      },
    ]);
    await hx.h['terminals:restart'](def!.id);
    expect(calls[1]).toEqual({
      prompt: null,
      flags: ['--resume', def?.sessionId],
    });
    // After a relaunch the new manager does not know the terminal; it still resumes.
    await hx.terminals.killAllForTask(t.id);
    const fresh = new TerminalManager();
    allTerminals.push(fresh);
    const h2 = createHandlers({ ...hx.services, terminals: fresh });
    await h2['terminals:restart'](def!.id);
    expect(calls[2]).toEqual({
      prompt: null,
      flags: ['--resume', def?.sessionId],
    });
  });

  it('denies agent tabs the untracked secret files of the task, never the tracked ones', async () => {
    const { platform } = recording();
    const denies: string[][] = [];
    const envCtx: { kind: string; denyPaths?: string[] }[] = [];
    const hx = await harness(fakeCrypto(), {
      platform,
      claudeThemeSettings: (deny) => {
        denies.push(deny ?? []);
        return null;
      },
      terminalEnv: (def, ctx) => {
        envCtx.push({ kind: def.kind, ...ctx });
        return {};
      },
    });
    const done = hx.setupDone();
    await hx.h['tasks:create'](
      hx.input({ openShell: true, startClaude: true, openOpencode: true }),
    );
    await done;
    const wt = hx.store.state.tasks[0].worktreePath;
    // A tracked config file with a secret-looking value stays readable.
    writeFileSync(
      path.join(wt, 'appsettings.json'),
      '{"Db":"Server=h;Password=pw1"}',
    );
    git(wt, 'add', 'appsettings.json');
    const claude = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'claude',
    )!;
    await hx.h['terminals:restart'](claude.id);
    expect(denies.at(-1)).toEqual([
      'Read(./.env)',
      'Bash(cat .env:*)',
      'Bash(type .env:*)',
      'Bash(Get-Content .env:*)',
    ]);
    const forKind = (k: string) => envCtx.filter((c) => c.kind === k).at(-1);
    expect(forKind('opencode')?.denyPaths).toEqual(['.env']);
    expect(forKind('claude')?.denyPaths).toEqual(['.env']);
    expect(forKind('shell')?.denyPaths).toBeUndefined();
  });

  it('starts and resumes Claude Code with the theme settings file and every terminal with COLORFGBG', async () => {
    const { platform, calls } = recording();
    let scheme: 'light' | 'dark' = 'light';
    const spawned: string[] = [];
    const hx = await harness(fakeCrypto(), {
      platform,
      claudeSessionExists: () => true,
      colorScheme: () => scheme,
      claudeThemeSettings: () => `/cfg/claude-theme-${scheme}.json`,
      claudeSpawned: (id) => spawned.push(id),
    });
    const spawn = vi.spyOn(hx.terminals, 'spawn');
    const done = hx.setupDone();
    await hx.h['tasks:create'](
      hx.input({ openShell: true, startClaude: true }),
    );
    await done;
    const def = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'claude',
    );
    expect(calls[0].flags).toEqual([
      '--session-id',
      def?.sessionId,
      '--settings',
      '/cfg/claude-theme-light.json',
    ]);
    expect(spawn.mock.calls.map((c) => c[0].env?.COLORFGBG)).toEqual([
      '0;15',
      '0;15',
    ]);
    scheme = 'dark';
    await hx.h['terminals:restart'](def!.id);
    expect(calls[1].flags).toEqual([
      '--resume',
      def?.sessionId,
      '--settings',
      '/cfg/claude-theme-dark.json',
    ]);
    expect(spawn.mock.calls.at(-1)?.[0].env?.COLORFGBG).toBe('15;0');
    // Only the Claude Code tab, at its start and its resume.
    expect(spawned).toEqual([def!.id, def!.id]);
  });

  it('continues the latest conversation for a Claude Code tab without a session id', async () => {
    const { platform, calls } = recording();
    const hx = await harness(fakeCrypto(), { platform });
    const done = hx.setupDone();
    await hx.h['tasks:create'](
      hx.input({ openShell: false, startClaude: true }),
    );
    await done;
    await hx.store.update((st) => {
      for (const d of st.tasks[0].terminals) delete d.sessionId;
    });
    const id = hx.store.state.tasks[0].terminals[0].id;
    await hx.h['terminals:restart'](id);
    expect(calls.at(-1)).toEqual({ prompt: null, flags: ['--continue'] });
  });

  it('starts a never-used session again instead of resuming it', async () => {
    const { platform, calls } = recording();
    const hx = await harness(fakeCrypto(), {
      platform,
      claudeSessionExists: () => false,
    });
    const done = hx.setupDone();
    await hx.h['tasks:create'](
      hx.input({ openShell: false, startClaude: true }),
    );
    await done;
    const def = hx.store.state.tasks[0].terminals[0];
    await hx.h['terminals:restart'](def.id);
    expect(calls.at(-1)).toEqual({
      prompt: expect.stringContaining('.shellie/task.md'),
      flags: ['--session-id', def.sessionId],
    });
  });

  it('gives a Claude Code tab opened by hand a session id', async () => {
    const { platform, calls } = recording();
    const hx = await harness(fakeCrypto(), { platform });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    const def = await hx.h['terminals:open'](t.id, {
      kind: 'claude',
      label: 'Claude Code',
    });
    expect(def.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.at(-1)?.flags).toEqual(['--session-id', def.sessionId]);
  });
});

describe('handlers: terminals opened from the + menu', () => {
  it('names a shell tab after the platform shell and starts OpenCode with its command', async () => {
    const base = testPlatform();
    const platform = {
      ...base,
      shellLabel: 'PowerShell',
      opencodeCommand: () =>
        base.runCommand(`${echoCmd('opencode-started')}; ${sleepCmd(5)}`),
    };
    const hx = await harness(fakeCrypto(), { platform });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    const shell = await hx.h['terminals:open'](t.id, {
      kind: 'shell',
      label: 'shell',
    });
    expect(shell.label).toBe('PowerShell');
    const oc = await hx.h['terminals:open'](t.id, {
      kind: 'opencode',
      label: 'OpenCode',
    });
    await vi.waitFor(
      async () =>
        expect(await hx.h['terminals:buffer'](oc.id)).toContain(
          'opencode-started',
        ),
      { timeout: 10_000 },
    );
    await hx.h['terminals:kill'](oc.id);
    expect(hx.store.state.tasks[0].terminals.map((x) => x.kind)).toEqual([
      'shell',
    ]);
    await hx.terminals.killAllForTask(t.id);
  });
});

describe('handlers: agent tabs that fail to start (#109)', () => {
  const failures = () => {
    const cleared: string[] = [];
    const spawnFailed: { id: string; kind: string }[] = [];
    const kept = new Map<string, TerminalFailure>();
    const service = {
      get: (id: string) => kept.get(id) ?? null,
      clear: (id: string) => {
        cleared.push(id);
        kept.delete(id);
      },
      spawnFailed: (id: string, kind: TerminalKind, e: unknown) => {
        spawnFailed.push({ id, kind });
        const f = spawnFailure(kind, String(e));
        kept.set(id, f);
        return f;
      },
    };
    return { service, cleared, spawnFailed, kept };
  };

  it('restarts OpenCode without the project config when asked, and with it again on a plain Restart', async () => {
    const base = testPlatform();
    const platform = {
      ...base,
      opencodeCommand: () =>
        base.runCommand(`${echoCmd('opencode-started')}; ${sleepCmd(5)}`),
    };
    const f = failures();
    const hx = await harness(fakeCrypto(), {
      platform,
      terminalFailures: f.service,
    });
    const spawn = vi.spyOn(hx.terminals, 'spawn');
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ openShell: false, openOpencode: true }),
    );
    await done;
    const def = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'opencode',
    )!;
    f.kept.set(def.id, {
      reason: 'invalid-config',
      title: 'x',
      hint: 'y',
      canSkipProjectConfig: true,
    });
    expect((await hx.h['terminals:failure'](def.id))?.reason).toBe(
      'invalid-config',
    );
    await hx.h['terminals:restart'](def.id, { withoutProjectConfig: true });
    expect(
      spawn.mock.calls.at(-1)?.[0].env?.OPENCODE_DISABLE_PROJECT_CONFIG,
    ).toBe('1');
    expect(f.cleared).toContain(def.id);
    expect(await hx.h['terminals:failure'](def.id)).toBeNull();
    expect(await hx.h['terminals:isRunning'](def.id)).toBe(true);
    await hx.h['terminals:restart'](def.id);
    expect(
      spawn.mock.calls.at(-1)?.[0].env?.OPENCODE_DISABLE_PROJECT_CONFIG,
    ).toBeUndefined();
    await hx.terminals.killAllForTask(t.id);
  });

  it('records a tab whose program cannot be spawned', async () => {
    const f = failures();
    const hx = await harness(fakeCrypto(), { terminalFailures: f.service });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    vi.spyOn(hx.terminals, 'spawn').mockImplementationOnce(() => {
      throw new Error('posix_spawnp failed.');
    });
    await expect(
      hx.h['terminals:open'](t.id, { kind: 'copilot', label: 'Copilot CLI' }),
    ).rejects.toThrow(/posix_spawnp/);
    expect(f.spawnFailed).toEqual([
      { id: expect.any(String), kind: 'copilot' },
    ]);
  });
});

describe('handlers: reopen a finished task', () => {
  const finishWith = (o: {
    removeWorktree: boolean;
    deleteBranch: boolean;
  }) => ({
    closeTerminals: true,
    ...o,
  });
  const recording = () => {
    const base = testPlatform();
    const calls: { context: string | null; flags: string[] }[] = [];
    const platform = {
      ...base,
      claudeCommand: (context: string | null, flags: string[] = []) => {
        calls.push({ context, flags });
        return base.runCommand(`${echoCmd('claude')}; ${sleepCmd(5)}`);
      },
    };
    return { platform, calls };
  };
  async function finished(
    o: { removeWorktree: boolean; deleteBranch: boolean },
    over: Partial<Services> = {},
    opts: { commands?: string[]; beforeFinish?: (t: Task) => void } = {},
  ) {
    const rec = recording();
    const hx = await harness(fakeCrypto(), {
      platform: rec.platform,
      claudeSessionExists: () => true,
      ...over,
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ startClaude: true, commands: opts.commands ?? [] }),
    );
    await done;
    commitFile(t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    opts.beforeFinish?.(t);
    const before = hx.store.state.tasks[0].terminals;
    await hx.h['tasks:finish'](t.id, finishWith(o));
    return { ...hx, ...rec, t, before };
  }
  const reopenSetup = async (hx: Awaited<ReturnType<typeof finished>>) => {
    const done = hx.setupDone();
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: true });
    return done;
  };

  it('a folder an earlier cleanup left behind is replaced by the restored worktree (#91)', async () => {
    const hx = await finished({ removeWorktree: true, deleteBranch: true });
    const wt = hx.t.worktreePath;
    // What a removal that git could not finish left on Windows (#87): files, no .git, no branch.
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, 'stray.txt'), 'left over');
    await reopenSetup(hx);
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('ready');
    expect(existsSync(path.join(wt, '.git'))).toBe(true);
    expect(existsSync(path.join(wt, 'stray.txt'))).toBe(false);
    expect(readFileSync(path.join(wt, 'feature.txt'), 'utf8')).toBe('a\n');
    expect(git(wt, 'branch', '--show-current').trim()).toBe(task.branch);
    await hx.terminals.killAllForTask(task.id);
  });

  it('a left-over folder stays when the branch cannot be restored (#91)', async () => {
    const hx = await finished({ removeWorktree: true, deleteBranch: true });
    const wt = hx.t.worktreePath;
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, 'stray.txt'), 'left over');
    await hx.store.update((st) => {
      st.tasks[0].summary = null;
    });
    await expect(hx.h['tasks:reopen'](hx.t.id)).rejects.toThrow(
      /cannot be restored/,
    );
    expect(existsSync(path.join(wt, 'stray.txt'))).toBe(true);
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('Finish keeps the tabs it closed, so Reopen can bring them back', async () => {
    const hx = await finished({ removeWorktree: true, deleteBranch: false });
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'done',
      terminals: [],
      closedTerminals: hx.before,
    });
    expect(hx.before.map((d) => d.kind)).toEqual(['claude', 'shell']);
  });

  const withExtra = async (hx: Awaited<ReturnType<typeof finished>>) => {
    const extraPath = mkdtempSync(path.join(os.tmpdir(), 'shellie-extra-'));
    git(extraPath, 'init', '-q');
    git(extraPath, 'config', 'user.email', 'tests@shellie.local');
    git(extraPath, 'config', 'user.name', 'Shellie tests');
    git(extraPath, 'config', 'core.autocrlf', 'false');
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces.push({
        id: 'w2',
        repoId: 'other',
        branch: 'b',
        worktreePath: extraPath,
        baseRef: 'HEAD',
        baseSha: null,
        source: 'detected',
        summary: null,
        pullRequest: null,
        reopen: null,
        dropped: false,
      });
    });
    return extraPath;
  };

  it('Claude gets --add-dir for the extra worktree, on resume and on start; dropped ones are left out', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    const extra = await withExtra(hx);
    const id = hx.t.id;
    const claude = hx.before.find((d) => d.kind === 'claude')!;
    await hx.h['tasks:reopen'](id);
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--resume',
      claude.sessionId,
      '--add-dir',
      extra,
    ]);
    await hx.h['terminals:open'](id, { kind: 'claude', label: 'Claude Code' });
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--session-id',
      expect.any(String),
      '--add-dir',
      extra,
    ]);
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces[0].dropped = true;
    });
    await hx.h['terminals:open'](id, { kind: 'claude', label: 'Claude Code' });
    expect(hx.calls.at(-1)?.flags).not.toContain('--add-dir');
    await hx.terminals.killAllForTask(id);
  });

  it("denies another repo's secret files by absolute path, and user secrets too", async () => {
    const denies: string[][] = [];
    const hx = await finished(
      { removeWorktree: false, deleteBranch: false },
      {
        claudeThemeSettings: (deny) => {
          denies.push(deny ?? []);
          return null;
        },
      },
    );
    const extra = await withExtra(hx);
    const us = mkdtempSync(path.join(os.tmpdir(), 'shellie-us-'));
    mkdirSync(path.join(us, 'abc'));
    writeFileSync(path.join(us, 'abc', 'secrets.json'), '{"K":"v1"}');
    (
      hx.services.platform as { userSecretsDir: (id: string) => string | null }
    ).userSecretsDir = (id) => path.join(us, id);
    writeFileSync(
      path.join(extra, 'Api.csproj'),
      '<Project><PropertyGroup><UserSecretsId>abc</UserSecretsId></PropertyGroup></Project>',
    );
    writeFileSync(path.join(extra, '.env'), 'A=1\n');
    mkdirSync(path.join(extra, 'secrets'));
    writeFileSync(path.join(extra, 'secrets', 'k.json'), '{"x":"1"}');
    await hx.h['tasks:reopen'](hx.t.id);
    await hx.h['terminals:open'](hx.t.id, {
      kind: 'claude',
      label: 'Claude Code',
    });
    const rules = denies.at(-1)!;
    expect(rules).toContain('Read(./.env)');
    // Claude Code matches a Windows path in POSIX form (`C:\\x` is `/c/x`); an absolute rule starts with `//`.
    const claudePath = (p: string) =>
      p
        .split(path.sep)
        .join('/')
        .replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    const abs = (f: string) => claudePath(path.join(extra, f));
    expect(rules).toContain(`Read(/${abs('.env')})`);
    expect(rules).toContain(`Read(/${abs('secrets')}/**)`);
    expect(rules).toContain(
      `Read(/${claudePath(path.join(us, 'abc', 'secrets.json'))})`,
    );
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('a discovery that throws means no rules and a tab that still starts', async () => {
    const denies: string[][] = [];
    const rec = recording();
    const hx = await harness(fakeCrypto(), {
      platform: {
        ...rec.platform,
        userSecretsDir: () => {
          throw new Error('boom');
        },
      },
      claudeThemeSettings: (deny) => {
        denies.push(deny ?? []);
        return null;
      },
    });
    writeFileSync(
      path.join(hx.repo, 'Api.csproj'),
      '<Project><PropertyGroup><UserSecretsId>abc</UserSecretsId></PropertyGroup></Project>',
    );
    writeFileSync(
      path.join(hx.repo, '.shellie.yml'),
      'copy: [.env, Api.csproj]\n',
    );
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ startClaude: true }));
    await done;
    const claude = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'claude',
    )!;
    await hx.h['terminals:restart'](claude.id);
    expect(denies.at(-1)).toEqual([]);
    expect(rec.calls.length).toBeGreaterThan(1);
    await hx.terminals.killAllForTask(t.id);
  });

  it("reuses a worktree's discovery for 30 s, then reads it again, and never keeps a failure", async () => {
    let clock = Date.now();
    let fail = true;
    let asked = 0;
    const denies: string[][] = [];
    const rec = recording();
    const hx = await harness(fakeCrypto(), {
      now: () => clock,
      platform: {
        ...rec.platform,
        userSecretsDir: () => {
          asked++;
          if (fail) throw new Error('boom');
          return '/nonexistent/none';
        },
      },
      claudeThemeSettings: (deny) => {
        denies.push(deny ?? []);
        return null;
      },
    });
    writeFileSync(
      path.join(hx.repo, 'Api.csproj'),
      '<Project><PropertyGroup><UserSecretsId>abc</UserSecretsId></PropertyGroup></Project>',
    );
    writeFileSync(
      path.join(hx.repo, '.shellie.yml'),
      'copy: [.env, Api.csproj]\n',
    );
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ startClaude: true }));
    await done;
    const claude = hx.store.state.tasks[0].terminals.find(
      (x) => x.kind === 'claude',
    )!;
    const restart = async () => {
      const before = asked;
      await hx.h['terminals:restart'](claude.id);
      return asked - before;
    };
    // The failure from the start is not kept: the next tab reads again, and finds the file.
    expect(await restart()).toBe(1);
    expect(denies.at(-1)).toEqual([]);
    fail = false;
    expect(await restart()).toBe(1);
    expect(denies.at(-1)).toContain('Read(./.env)');
    clock += 29_000;
    expect(await restart()).toBe(0);
    clock += 2_000;
    expect(await restart()).toBe(1);
    await hx.terminals.killAllForTask(t.id);
  });

  it('Claude gets no --add-dir for a workspace whose folder is gone', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    const extra = await withExtra(hx);
    await hx.h['tasks:reopen'](hx.t.id);
    rmSync(extra, { recursive: true, force: true });
    await hx.h['terminals:open'](hx.t.id, {
      kind: 'claude',
      label: 'Claude Code',
    });
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--session-id',
      expect.any(String),
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('opens a shell in the workspace asked for, else in the active home', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    const extra = await withExtra(hx);
    await hx.terminals.killAllForTask(hx.t.id);
    await hx.store.update((st) => {
      st.tasks[0].status = 'ready';
    });
    const spy = vi.spyOn(hx.terminals, 'spawn');
    await hx.h['terminals:open'](hx.t.id, {
      kind: 'shell',
      label: 'sh',
      workspaceId: 'w2',
    });
    await hx.h['terminals:open'](hx.t.id, { kind: 'shell', label: 'sh' });
    expect(spy.mock.calls.map((c) => c[0].cwd)).toEqual([
      extra,
      hx.t.worktreePath,
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('summarises an extra worktree against its own baseRef', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    const extra = await withExtra(hx);
    commitFile(extra, 'a.txt', 'a\n', 'first');
    commitFile(extra, 'b.txt', 'b\n', 'second');
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces[0].baseRef = 'HEAD~1';
    });
    writeFileSync(path.join(extra, 'c.txt'), 'c\n');
    const sum = await hx.h['tasks:gitSummary'](hx.t.id, 'w2');
    expect(sum.files.map((f) => f.path)).toEqual(['c.txt']);
    expect(sum.ahead).toBe(1);
    const home = await hx.h['tasks:gitSummary'](hx.t.id);
    expect(home.files.map((f) => f.path)).not.toContain('c.txt');
  });

  it('a terminal of a removed or dropped workspace runs in the active home', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    await withExtra(hx);
    await hx.terminals.killAllForTask(hx.t.id);
    await hx.store.update((st) => {
      st.tasks[0].status = 'ready';
      st.tasks[0].extraWorkspaces[0].dropped = true;
    });
    const spy = vi.spyOn(hx.terminals, 'spawn');
    for (const workspaceId of ['w2', 'gone'])
      await hx.h['terminals:open'](hx.t.id, {
        kind: 'shell',
        label: 'sh',
        workspaceId,
      });
    expect(spy.mock.calls.map((c) => c[0].cwd)).toEqual([
      hx.t.worktreePath,
      hx.t.worktreePath,
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('reopens a task whose worktree was kept, without setup, resuming Claude', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: false });
    const task = hx.store.state.tasks[0];
    expect(task).toMatchObject({
      status: 'ready',
      finishedAt: null,
      closedTerminals: [],
    });
    expect(task.openPeriods).toHaveLength(2);
    expect(task.openPeriods[0].end).not.toBeNull();
    expect(task.openPeriods[1].end).toBeNull();
    expect(task.terminals.map((d) => d.id)).toEqual(hx.before.map((d) => d.id));
    const claude = hx.before.find((d) => d.kind === 'claude')!;
    expect(hx.calls.at(-1)).toEqual({
      context: null,
      flags: ['--resume', claude.sessionId],
    });
    expect(hx.terminals.runningCount(hx.t.id)).toBe(2);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('reopening a task from before time tracking keeps creation to finish as its first period', async () => {
    const hx = await finished({ removeWorktree: false, deleteBranch: false });
    await hx.store.update((st) => {
      st.tasks[0].openPeriods = [];
    });
    const { createdAt, finishedAt } = hx.store.state.tasks[0];
    await hx.h['tasks:reopen'](hx.t.id);
    const periods = hx.store.state.tasks[0].openPeriods;
    expect(periods[0]).toEqual({ start: createdAt, end: finishedAt });
    expect(periods).toHaveLength(2);
    expect(periods[1].end).toBeNull();
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('does not run the Setup tab again when reopening a kept worktree', async () => {
    const hx = await finished(
      { removeWorktree: false, deleteBranch: false },
      {},
      { commands: [echoCmd('setup')] },
    );
    expect(hx.before.some((d) => d.setupCommands)).toBe(true);
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: false });
    expect(hx.store.state.tasks[0].terminals.map((d) => d.kind)).toEqual([
      'claude',
      'shell',
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('makes the worktree again from the local branch and runs the setup again', async () => {
    const hx = await finished(
      { removeWorktree: true, deleteBranch: false },
      {},
      { commands: [writeLineCmd('ok', 'ok.txt')] },
    );
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    const oldSetupTab = hx.before.find((d) => d.setupCommands)!;
    expect(oldSetupTab).toBeDefined();
    const result = await reopenSetup(hx);
    expect(result.ok).toBe(true);
    expect(
      hx.store.state.tasks[0].openPeriods.map((p) => p.end === null),
    ).toEqual([false, true]);
    expect(existsSync(path.join(hx.t.worktreePath, 'feature.txt'))).toBe(true);
    await vi.waitFor(
      () =>
        expect(existsSync(path.join(hx.t.worktreePath, 'ok.txt'))).toBe(true),
      { timeout: 10_000 },
    );
    const tabs = hx.store.state.tasks[0].terminals;
    // A fresh Setup tab; the one from before Finish is not brought back.
    expect(tabs.filter((d) => d.setupCommands)).toHaveLength(1);
    expect(tabs.map((d) => d.id)).not.toContain(oldSetupTab.id);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'ready',
      reopen: null,
      extraWorkspaces: [],
      detachedPaths: [],
      homeDropped: false,
      connectionId: null,
      mainCheckoutEdits: [],
      environment: 'development',
      environmentUntil: null,
      pendingCleanup: [],
      finishedAt: null,
      baseSha: hx.t.baseSha ?? hx.store.state.tasks[0].baseSha,
    });
    expect(hx.store.state.tasks[0].terminals.map((d) => d.kind)).toEqual([
      'claude',
      'shell',
      'run',
    ]);
    expect(hx.calls.findLast((c) => c.flags.length > 0)?.flags[0]).toBe(
      '--resume',
    );
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('brings a deleted branch back from origin', async () => {
    const rec = recording();
    const hx = await harness(fakeCrypto(), { platform: rec.platform });
    addOrigin(hx.repo);
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    commitFile(t.worktreePath, 'pushed.txt', 'a\n', 'Pushed work');
    git(t.worktreePath, 'push', '-q', 'origin', t.branch);
    await hx.h['tasks:finish'](
      t.id,
      finishWith({ removeWorktree: true, deleteBranch: true }),
    );
    const finishedDone = hx.setupDone();
    expect(await hx.h['tasks:reopen'](t.id)).toEqual({ setup: true });
    expect(hx.store.state.tasks[0].reopen).toEqual({
      from: `origin/${t.branch}`,
    });
    expect((await finishedDone).ok).toBe(true);
    expect(existsSync(path.join(t.worktreePath, 'pushed.txt'))).toBe(true);
  });

  it('brings a deleted, unpushed branch back from its last commit', async () => {
    const hx = await finished({ removeWorktree: true, deleteBranch: true });
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(
      false,
    );
    const result = await reopenSetup(hx);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(hx.t.worktreePath, 'feature.txt'))).toBe(true);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('refuses when the branch is gone for good, and the task stays done', async () => {
    const hx = await finished({ removeWorktree: true, deleteBranch: true });
    await hx.store.update((st) => {
      st.tasks[0].summary!.commits = [{ sha: 'f'.repeat(40), subject: 'x' }];
    });
    await expect(hx.h['tasks:reopen'](hx.t.id)).rejects.toThrow(
      `Branch ${hx.t.branch} cannot be restored`,
    );
    expect(hx.store.state.tasks[0].status).toBe('done');
    // Not left busy: a second try gives the same answer, not "Task is busy".
    await expect(hx.h['tasks:reopen'](hx.t.id)).rejects.toThrow(
      'cannot be restored',
    );
  });

  it('cancelling a failed reopen puts the task back to done and keeps it', async () => {
    const hx = await finished(
      { removeWorktree: true, deleteBranch: false },
      {},
      {
        beforeFinish: (t) =>
          commitFile(t.worktreePath, 'apm.yml', 'name: webshop\n'),
      },
    );
    hx.failSetup();
    const result = await reopenSetup(hx);
    expect(result.ok).toBe(false);
    expect(hx.store.state.tasks[0].status).toBe('setup-failed');
    await hx.h['tasks:cancelSetup'](hx.t.id);
    expect(hx.store.state.tasks).toHaveLength(1);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'done',
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
    expect(
      hx.store.state.tasks[0].openPeriods.every((p) => p.end !== null),
    ).toBe(true);
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(true);
  });

  it('continues the latest Claude session in the folder for a task finished before tabs were kept', async () => {
    const hx = await finished(
      { removeWorktree: false, deleteBranch: false },
      { claudeHasSessionsIn: () => true },
    );
    await hx.store.update((st) => {
      st.tasks[0].closedTerminals = [];
    });
    await hx.h['tasks:reopen'](hx.t.id);
    expect(hx.calls.at(-1)).toEqual({ context: null, flags: ['--continue'] });
    await hx.terminals.killAllForTask(hx.t.id);
  });
  /**
   * A task in `webshop` (home, no changes) plus a worktree on its branch in `api` with one commit, finished with
   * its worktrees removed and branches kept. `api`'s .shellie.yml copies .env and writes api.txt.
   */
  async function finishedMulti(
    o: {
      home?: 'keep' | 'drop';
      extra?: 'keep' | 'drop';
      apiSetup?: string[];
      /** Created without tabs; one Claude tab is opened by hand before Finish. */
      noInitialTabs?: boolean;
    } = {},
  ) {
    const rec = recording();
    const api = makeRepo('api');
    writeFileSync(path.join(api, '.env'), 'API=1');
    const apiSetup = o.apiSetup ?? [writeLineCmd('api', 'api.txt')];
    const hx = await harness(fakeCrypto(), {
      platform: rec.platform,
      claudeSessionExists: () => true,
      loadConfig: async (p) =>
        p === api
          ? { ...(await loadShellieConfig(p)), copy: ['.env'], setup: apiSetup }
          : loadShellieConfig(p),
    });
    // The copied .env is ignored, as in a real repo, so a home without commits can be dropped.
    commitFile(hx.repo, '.gitignore', '.env\n');
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({
        startClaude: !o.noInitialTabs,
        openShell: false,
        commands: [],
      }),
    );
    await done;
    if (o.noInitialTabs)
      await hx.h['terminals:open'](t.id, { kind: 'claude', label: 'Claude' });
    const added = await hx.h['repos:add'](api);
    const wt = path.join(path.dirname(api), 'api-wt');
    git(api, 'worktree', 'add', '-q', '-b', t.branch, wt, 'main');
    if (o.extra !== 'drop') commitFile(wt, 'api-work.txt', 'a\n', 'API work');
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces.push({
        id: 'w2',
        repoId: added.id,
        branch: t.branch,
        worktreePath: wt,
        baseRef: 'main',
        baseSha: null,
        source: 'detected',
        summary: null,
        pullRequest: null,
        reopen: null,
        dropped: false,
      });
    });
    const before = hx.store.state.tasks[0].terminals;
    await hx.h['tasks:finish'](t.id, {
      ...finishWith({ removeWorktree: true, deleteBranch: false }),
      workspaces: [
        { workspaceId: 'home', action: o.home ?? 'keep' },
        { workspaceId: 'w2', action: o.extra ?? 'keep' },
      ],
    });
    expect(hx.store.state.tasks[0].status).toBe('done');
    expect(existsSync(t.worktreePath)).toBe(false);
    expect(existsSync(wt)).toBe(false);
    return { ...hx, ...rec, t, before, api, wt };
  }
  const extraOf = (hx: { store: TaskStore }) =>
    hx.store.state.tasks[0].extraWorkspaces[0];

  it('reopens every repo: reopen.from on each, both worktrees made again with their own setup', async () => {
    const hx = await finishedMulti();
    const done = hx.setupDone();
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: true });
    expect(hx.store.state.tasks[0].reopen).toEqual({ from: null });
    expect(extraOf(hx).reopen).toEqual({ from: null });
    expect((await done).ok).toBe(true);
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps.map((x) => x.def.label)).toEqual([
      'Restore worktree',
      'Copy local files',
      'Write task file',
      'Restore api worktree',
      'Copy local files (api)',
      writeLineCmd('api', 'api.txt'),
      'Restore terminals',
    ]);
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(existsSync(path.join(hx.wt, 'api-work.txt'))).toBe(true);
    expect(existsSync(path.join(hx.wt, '.env'))).toBe(true);
    expect(existsSync(path.join(hx.wt, 'api.txt'))).toBe(true);
    expect(existsSync(path.join(hx.t.worktreePath, 'api.txt'))).toBe(false);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'ready',
      reopen: null,
      finishedAt: null,
    });
    expect(extraOf(hx).reopen).toBeNull();
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--resume',
      hx.before[0].sessionId,
      '--add-dir',
      hx.wt,
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('a dropped repo is not restored', async () => {
    const hx = await finishedMulti({ extra: 'drop' });
    expect(extraOf(hx).dropped).toBe(true);
    const done = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect(extraOf(hx).reopen).toBeNull();
    expect((await done).ok).toBe(true);
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps.map((x) => x.def.label)).toEqual([
      'Restore worktree',
      'Copy local files',
      'Write task file',
      'Restore terminals',
    ]);
    expect(existsSync(hx.wt)).toBe(false);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('a task whose home was dropped restores only the other repo, and Claude resumes there', async () => {
    const hx = await finishedMulti({ home: 'drop' });
    expect(hx.store.state.tasks[0].homeDropped).toBe(true);
    const spy = vi.spyOn(hx.terminals, 'spawn');
    const done = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect(hx.store.state.tasks[0].reopen).toBeNull();
    expect(extraOf(hx).reopen).toEqual({ from: null });
    expect((await done).ok).toBe(true);
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps.map((x) => x.def.label)).toEqual([
      'Restore api worktree',
      'Copy local files (api)',
      writeLineCmd('api', 'api.txt'),
      'Restore terminals',
    ]);
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(existsSync(path.join(hx.wt, 'api-work.txt'))).toBe(true);
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(spy.mock.calls.map((c) => c[0].cwd)).toEqual([hx.wt]);
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--resume',
      hx.before[0].sessionId,
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('a task whose home was dropped is not "folder missing" once reopened', async () => {
    const hx = await finishedMulti({ home: 'drop' });
    const done = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect((await done).ok).toBe(true);
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    const [view] = await hx.h['tasks:list']();
    expect(view.worktreeMissing).toBe(false);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('a dropped-home reopen of a task created without tabs brings back the tabs it had at Finish', async () => {
    const hx = await finishedMulti({ home: 'drop', noInitialTabs: true });
    expect(hx.before.map((d) => d.kind)).toEqual(['claude']);
    const done = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect((await done).ok).toBe(true);
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps.at(-1)!.def).toMatchObject({
      label: 'Restore terminals',
      detail: 'Claude',
    });
    // A reopen never touches the work item.
    expect(state!.steps.map((x) => x.def.kind)).not.toContain('workitem');
    expect(hx.store.state.tasks[0].terminals).toEqual(hx.before);
    expect(hx.calls.at(-1)?.flags).toEqual([
      '--resume',
      hx.before[0].sessionId,
    ]);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('names the repo whose branch cannot be restored', async () => {
    const hx = await finishedMulti();
    git(hx.api, 'branch', '-D', hx.t.branch);
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces[0].summary = null;
    });
    await expect(hx.h['tasks:reopen'](hx.t.id)).rejects.toThrow(
      `api: branch ${hx.t.branch} cannot be restored`,
    );
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('a failing restore of a repo fails setup at its step, and Retry resumes there', async () => {
    const hx = await finishedMulti({ apiSetup: [failCmd(3)] });
    const failed = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect(await failed).toMatchObject({ ok: false, failedStep: 5 });
    expect(hx.store.state.tasks[0].status).toBe('setup-failed');
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps[5].def).toMatchObject({
      kind: 'command',
      detail: 'in api',
      workspaceId: 'w2',
    });
    // The repo's setup command is fixed; the retry starts at the failed step.
    const runSpy = vi.spyOn(hx.services.runner, 'run');
    const retried = hx.setupDone();
    hx.services.loadConfig = async (p) =>
      p === hx.api
        ? {
            ...(await loadShellieConfig(p)),
            copy: ['.env'],
            setup: [writeLineCmd('retried', 'api.txt')],
          }
        : loadShellieConfig(p);
    await hx.h['tasks:retrySetup'](hx.t.id);
    expect((await retried).ok).toBe(true);
    expect(runSpy.mock.calls[0][1].fromStep).toBe(5);
    expect(existsSync(path.join(hx.wt, 'api.txt'))).toBe(true);
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(extraOf(hx).reopen).toBeNull();
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('cancelling a failed reopen removes every remade worktree and the task goes back to done', async () => {
    const hx = await finishedMulti({ apiSetup: [failCmd(3)] });
    const failed = hx.setupDone();
    await hx.h['tasks:reopen'](hx.t.id);
    expect((await failed).ok).toBe(false);
    expect(existsSync(hx.wt)).toBe(true);
    await hx.h['tasks:cancelSetup'](hx.t.id);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'done',
      reopen: null,
    });
    expect(extraOf(hx).reopen).toBeNull();
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(existsSync(hx.wt)).toBe(false);
    expect(await new GitClient().branchExists(hx.api, hx.t.branch)).toBe(true);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(true);
  });

  it('a kept home with a removed repo goes through setup for that repo only', async () => {
    const hx = await finishedMulti();
    git(hx.repo, 'worktree', 'add', '-q', hx.t.worktreePath, hx.t.branch);
    writeFileSync(path.join(hx.t.worktreePath, 'mine.txt'), 'x');
    const done = hx.setupDone();
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: true });
    expect(hx.store.state.tasks[0].reopen).toBeNull();
    expect((await done).ok).toBe(true);
    const state = await hx.h['tasks:setupState'](hx.t.id);
    expect(state!.steps[0].def.label).toBe('Restore api worktree');
    expect(existsSync(path.join(hx.wt, 'api-work.txt'))).toBe(true);
    expect(existsSync(path.join(hx.t.worktreePath, 'mine.txt'))).toBe(true);
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('reopens without setup when every repo kept its worktree', async () => {
    const hx = await finishedMulti();
    git(hx.repo, 'worktree', 'add', '-q', hx.t.worktreePath, hx.t.branch);
    git(hx.api, 'worktree', 'add', '-q', hx.wt, hx.t.branch);
    expect(await hx.h['tasks:reopen'](hx.t.id)).toEqual({ setup: false });
    expect(hx.store.state.tasks[0].status).toBe('ready');
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('refuses when every repo was removed without changes', async () => {
    const hx = await finishedMulti({ home: 'drop', extra: 'drop' });
    await expect(hx.h['tasks:reopen'](hx.t.id)).rejects.toThrow(
      'Nothing to reopen: every repo of this task was removed without changes',
    );
    expect(hx.store.state.tasks[0].status).toBe('done');
  });
});
