// handlers tests, part 4 of 6 (split so CI can run them on several machines at once).
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LEAK_IN_BRANCH, LEAK_UNCHECKED } from '../../shared/secrets';
import type { CreateTaskInput } from '../../shared/types';
import { fakeCrypto } from '../test-helpers/fakeCrypto';
import { GitAuthError, GitClient } from '../services/GitClient';
import { TaskStore } from '../services/TaskStore';
import { NoopTelemetry } from '../telemetry/AppInsightsClient';
import type { WorkspaceDetector } from '../workspaces/WorkspaceDetector';
import { addOrigin, commitFile, git, makeRepo } from '../test-helpers/gitRepo';
import { AdoError, CODE_WRITE_DENIED } from '../services/AdoClient';
import { prTitle } from '../services/azureRepos';
import { type Services } from './handlers';
import {
  telemetryEvents,
  harness,
  expectTerminalsKept,
  linkedTask,
} from './handlersHarness';

describe('handlers: finish with a pull request', () => {
  const PR_URL = 'https://dev.azure.com/contoso/P/_git/R/pullrequest/7';
  const finishWithPr = {
    closeTerminals: true,
    removeWorktree: true,
    deleteBranch: true,
    createPullRequest: true,
  };

  async function prHarness(
    remote = 'https://dev.azure.com/contoso/P/_git/R',
    over: Partial<CreateTaskInput> = {},
    services: Partial<Services> = {},
  ) {
    const hx = await harness(fakeCrypto(), services);
    const bare = addOrigin(hx.repo);
    const c = await hx.connections.save({
      organizationUrl: 'https://dev.azure.com/contoso',
      project: 'P',
      pat: 'p',
    });
    await hx.h['repos:setConnection'](hx.added.id, c.id);
    vi.spyOn(hx.services.git, 'remoteUrl').mockResolvedValue(remote);
    const client = hx.services.trackers.client(c.id);
    const repositoryId = vi
      .spyOn(client, 'repositoryId')
      .mockResolvedValue('repo-1');
    const findActive = vi
      .spyOn(client, 'findActivePullRequest')
      .mockResolvedValue(null);
    const create = vi.spyOn(client, 'createPullRequest').mockResolvedValue({
      pullRequestId: 7,
      status: 'active',
      isDraft: true,
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({ baseRef: 'origin/main', openShell: false, ...over }),
    );
    await done;
    return { ...hx, bare, c, client, repositoryId, findActive, create, t };
  }

  it('reports availability with the target branch', async () => {
    const hx = await prHarness();
    expect(await hx.h['tasks:prAvailability'](hx.t.id)).toEqual({
      available: true,
      reason: null,
      target: 'main',
    });
    vi.mocked(hx.services.git.remoteUrl).mockResolvedValue(
      'https://github.com/contoso/R.git',
    );
    expect(await hx.h['tasks:prAvailability'](hx.t.id)).toEqual({
      available: false,
      reason: 'origin is not an Azure Repos URL',
      target: null,
    });
  });

  it('tells telemetry to scrub the project and repo of the Azure Repos remote', async () => {
    const hx = await prHarness(
      'git@ssh.dev.azure.com:v3/contoso/Other%20Project/azure-repo',
    );
    const seen: string[] = [];
    hx.services.rememberSensitive = (values) => seen.push(...values);
    await hx.h['tasks:prAvailability'](hx.t.id);
    expect(seen).toEqual(
      expect.arrayContaining(['Other Project', 'azure-repo']),
    );
  });

  it('pushes, creates a draft PR linked to the work item, opens it, then cleans up', async () => {
    const hx = await prHarness();
    commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    await hx.h['tasks:finish'](hx.t.id, finishWithPr);
    expect(git(hx.bare, 'branch', '--list', hx.t.branch).trim()).toContain(
      hx.t.branch,
    );
    expect(hx.repositoryId).toHaveBeenCalledWith('P', 'R');
    expect(hx.findActive).toHaveBeenCalledWith('P', 'repo-1', hx.t.branch);
    expect(hx.create).toHaveBeenCalledWith(
      'P',
      'repo-1',
      expect.objectContaining({
        source: hx.t.branch,
        target: 'main',
        title: prTitle(hx.t),
        workItemId: 48231,
      }),
    );
    const description = hx.create.mock.calls[0][2].description;
    expect(description).toContain('Add the feature');
    expect(description).not.toContain('AI cost');
    expect(hx.opened).toEqual([PR_URL]);
    const [view] = await hx.h['tasks:list']();
    expect(view.status).toBe('done');
    expect(view.pullRequest).toEqual({
      id: 7,
      url: PR_URL,
      repositoryId: 'repo-1',
      project: 'P',
      repo: 'R',
      status: 'active',
      isDraft: true,
    });
    expect(existsSync(hx.t.worktreePath)).toBe(false);
  });

  it('puts the written summary in the PR description above the commits', async () => {
    const hx = await prHarness();
    commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    await hx.h['tasks:finish'](hx.t.id, {
      ...finishWithPr,
      prSummaries: { home: '## What changed\n- The feature\n\n## Why\nAsked.' },
    });
    const description: string = hx.create.mock.calls[0][2].description;
    expect(description).toMatch(
      /^User Story 48231: Show estimated delivery date\n\n## What changed\n- The feature\n\n## Why\nAsked\.\n\n## Commits\n- [0-9a-f]+ Add the feature/,
    );
  });

  it('refuses to push a branch that adds a stored value unless Finish confirms it', async () => {
    const hx = await prHarness();
    await hx.services.secrets.save({
      scope: 'all',
      name: 'PROD_DB',
      givenTo: ['run'],
      values: { production: { value: 'prod-db-password-9f2c' } },
    });
    commitFile(
      hx.t.worktreePath,
      'config.txt',
      'db=prod-db-password-9f2c\n',
      'Add config',
    );
    const push = vi.spyOn(hx.services.git, 'push');
    const error = await hx.h['tasks:finish'](hx.t.id, finishWithPr).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).toContain(LEAK_IN_BRANCH);
    expect(error).not.toMatch(/PROD_DB|prod-db/);
    expect(push).not.toHaveBeenCalled();
    expect(hx.store.state.tasks[0].status).toBe('ready');
    await hx.h['tasks:finish'](hx.t.id, { ...finishWithPr, confirmLeak: true });
    expect(push).toHaveBeenCalledTimes(1);
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('reports a push refused for a stored value with its environment (telemetry)', async () => {
    const tel = telemetryEvents();
    const hx = await prHarness(undefined, undefined, {
      telemetry: tel.telemetry,
    });
    await hx.services.secrets.save({
      scope: 'all',
      name: 'PROD_DB',
      givenTo: ['run'],
      values: { production: { value: 'prod-db-password-9f2c' } },
    });
    commitFile(
      hx.t.worktreePath,
      'config.txt',
      'db=prod-db-password-9f2c\n',
      'Add config',
    );
    await hx.h['tasks:finish'](hx.t.id, finishWithPr).catch(() => undefined);
    expect(tel.named('secrets.leakDetected')).toEqual([
      [
        'secrets.leakDetected',
        { where: 'push', environment: 'production' },
        undefined,
      ],
    ]);
  });

  it('refuses a value one commit added and a later one removed: the push sends the history', async () => {
    const hx = await prHarness();
    await hx.services.secrets.save({
      scope: 'all',
      name: 'PROD_DB',
      givenTo: ['run'],
      values: { production: { value: 'prod-db-password-9f2c' } },
    });
    commitFile(
      hx.t.worktreePath,
      'config.txt',
      'db=prod-db-password-9f2c\n',
      'Add',
    );
    commitFile(hx.t.worktreePath, 'config.txt', 'db=from-env\n', 'Remove');
    const push = vi.spyOn(hx.services.git, 'push');
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      LEAK_IN_BRANCH,
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses a branch it cannot check (no base, or git failing) unless confirmed', async () => {
    const hx = await prHarness();
    await hx.services.secrets.save({
      scope: 'all',
      name: 'PROD_DB',
      givenTo: ['run'],
      values: { production: { value: 'prod-db-password-9f2c' } },
    });
    commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    const push = vi.spyOn(hx.services.git, 'push');
    const base = vi.spyOn(hx.services.git, 'resolveBase');
    base.mockResolvedValue(null);
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      LEAK_UNCHECKED,
    );
    // A base git does not know: `git log` fails.
    base.mockResolvedValue('0'.repeat(40));
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      LEAK_UNCHECKED,
    );
    expect(push).not.toHaveBeenCalled();
    await hx.h['tasks:finish'](hx.t.id, { ...finishWithPr, confirmLeak: true });
    expect(push).toHaveBeenCalledTimes(1);
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  describe('tasks:prSummary', () => {
    const result = (text: string) =>
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: text,
      });

    it("asks Claude Code with the branch, the work item and the developer's requests", async () => {
      const events: [string, unknown, unknown][] = [];
      const hx = await prHarness(undefined, undefined, {
        telemetry: {
          ...NoopTelemetry,
          event: (name, props, m) => events.push([name, props, m]),
        },
      });
      commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
      const sessions = mkdtempSync(path.join(os.tmpdir(), 'shellie-sess-'));
      const log = path.join(sessions, 'abc.jsonl');
      writeFileSync(
        log,
        `${JSON.stringify({ type: 'user', message: { content: 'Show the delivery date on the PDP' } })}\n`,
      );
      hx.services.claudeSessionFile = (id) => (id === 'abc' ? log : null);
      await hx.store.update((st) => {
        st.tasks[0].terminals.push({
          id: 'c1',
          kind: 'claude',
          label: 'Claude Code',
          sessionId: 'abc',
        });
      });
      const calls: {
        args: string[];
        cwd: string;
        input: string;
        env?: Record<string, string>;
      }[] = [];
      hx.services.runAgent = async (cmd, o) => {
        calls.push({ args: cmd.args, cwd: o.cwd, input: o.input, env: o.env });
        return result('```markdown\n## What changed\n- Dates\n```');
      };
      const r = await hx.h['tasks:prSummary'](hx.t.id);
      expect(r).toEqual({ text: '## What changed\n- Dates', error: null });
      expect(calls).toHaveLength(1);
      expect(calls[0].cwd).toBe(hx.t.worktreePath);
      expect(calls[0].args.join(' ')).toContain('-p');
      expect(calls[0].input).toContain(
        'User Story 48231: Show estimated delivery date',
      );
      expect(calls[0].input).toContain('Show the delivery date on the PDP');
      expect(calls[0].input).toContain('Add the feature');
      expect(calls[0].input).toContain('+a');
      // The run's usage counts for the task.
      expect(calls[0].env?.OTEL_RESOURCE_ATTRIBUTES).toBe(
        `shellie.task.id=${hx.t.id},shellie.source=pr-summary`,
      );
      expect(calls[0].env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
      expect(events).toContainEqual([
        'pr.summary',
        { ok: true, style: false },
        expect.objectContaining({ chars: 23 }),
      ]);
    });

    it('denies Claude the secret files and masks stored values in the prompt and the text', async () => {
      const deny: string[][] = [];
      const hx = await prHarness(undefined, undefined, {
        claudeThemeSettings: (d) => {
          deny.push(d ?? []);
          return '/settings/claude-deny.json';
        },
      });
      const value = 'sk_live_abcdefghijkl0b3d';
      await hx.services.secrets.save({
        scope: { repoId: hx.added.id },
        name: 'STRIPE_KEY',
        givenTo: ['run'],
        values: { development: { value } },
      });
      commitFile(
        hx.t.worktreePath,
        'feature.txt',
        `key=${value}\n`,
        'Add the feature',
      );
      writeFileSync(
        path.join(hx.t.worktreePath, '.env'),
        `STRIPE_KEY=${value}\n`,
      );
      let call: { args: string[]; input: string } | null = null;
      hx.services.runAgent = async (cmd, o) => {
        call = { args: cmd.args, input: o.input };
        return result(`## What changed\n- Uses ${value}`);
      };
      const r = await hx.h['tasks:prSummary'](hx.t.id);
      expect(call!.input).not.toContain(value);
      expect(call!.input).toContain('[STRIPE_KEY]');
      expect(r.text).not.toContain(value);
      expect(r.text).toContain('[STRIPE_KEY]');
      // Quoted for the platform's shell: only the order is checked.
      expect(call!.args.join(' ')).toMatch(
        /--settings\W+\/settings\/claude-deny\.json/,
      );
      expect(deny.at(-1)).toContain('Read(./.env)');
    });

    it("adds the repo's style file to the prompt", async () => {
      const hx = await prHarness();
      commitFile(
        hx.t.worktreePath,
        '.shellie-pr.md',
        'Always end with a Testing section.\n',
        'Add the style',
      );
      let input = '';
      hx.services.runAgent = async (_cmd, o) => {
        input = o.input;
        return result('ok');
      };
      await hx.h['tasks:prSummary'](hx.t.id);
      expect(input).toContain('Always end with a Testing section.');
    });

    it('gives the reason, never throws, when Claude Code fails', async () => {
      const events: [string, unknown][] = [];
      const hx = await prHarness(undefined, undefined, {
        telemetry: {
          ...NoopTelemetry,
          event: (name, props) => events.push([name, props]),
        },
      });
      commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
      hx.services.runAgent = async () => {
        throw new Error('Claude Code (claude) was not found');
      };
      expect(await hx.h['tasks:prSummary'](hx.t.id)).toEqual({
        text: null,
        error: 'Claude Code (claude) was not found',
      });
      hx.services.runAgent = async () => {
        throw new Error('timed out after 120 s');
      };
      await hx.h['tasks:prSummary'](hx.t.id);
      hx.services.runAgent = async () => result('   ');
      expect((await hx.h['tasks:prSummary'](hx.t.id)).text).toBeNull();
      expect(events.filter((e) => e[0] === 'pr.summary')).toEqual([
        ['pr.summary', { ok: false, reason: 'no-agent', style: false }],
        ['pr.summary', { ok: false, reason: 'timeout', style: false }],
        ['pr.summary', { ok: false, reason: 'empty', style: false }],
      ]);
    });
  });

  it('records the branch as pushed in the Done summary, since the PR pushed it', async () => {
    const hx = await prHarness();
    commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    await hx.h['tasks:finish'](hx.t.id, finishWithPr);
    const [view] = await hx.h['tasks:list']();
    expect(view.summary).toMatchObject({
      pushed: true,
      upstream: `origin/${hx.t.branch}`,
      commitCount: 1,
    });
  });

  it('links an existing active PR instead of creating another', async () => {
    const hx = await prHarness();
    hx.findActive.mockResolvedValue({
      pullRequestId: 3,
      status: 'active',
      isDraft: false,
    });
    await hx.h['tasks:finish'](hx.t.id, finishWithPr);
    expect(hx.create).not.toHaveBeenCalled();
    const [view] = await hx.h['tasks:list']();
    expect(view.pullRequest).toMatchObject({ id: 3, isDraft: false });
    expect(hx.opened).toEqual([
      'https://dev.azure.com/contoso/P/_git/R/pullrequest/3',
    ]);
  });

  it('stops Finish before cleanup when the push is rejected', async () => {
    const hx = await prHarness('https://dev.azure.com/contoso/P/_git/R', {
      openShell: true,
    });
    commitFile(hx.t.worktreePath, 'mine.txt', 'a\n', 'Mine');
    git(hx.t.worktreePath, 'push', '-q', 'origin', hx.t.branch);
    const other = path.join(path.dirname(hx.bare), 'other');
    git(
      path.dirname(hx.bare),
      'clone',
      '-q',
      '-b',
      hx.t.branch,
      hx.bare,
      'other',
    );
    git(other, 'config', 'user.email', 'tests@shellie.local');
    git(other, 'config', 'user.name', 'Shellie tests');
    commitFile(other, 'theirs.txt', 'b\n', 'Theirs');
    git(other, 'push', '-q', 'origin', hx.t.branch);
    git(hx.t.worktreePath, 'commit', '-q', '--amend', '-m', 'Mine again');
    const kill = vi.spyOn(hx.terminals, 'kill');
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      /^Pull request not created: [^]*rejected/,
    );
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(hx.store.state.tasks[0].pullRequest).toBeNull();
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
    expectTerminalsKept(hx.store, hx.terminals, hx.t.id, 1);
    expect(hx.create).not.toHaveBeenCalled();
    expect(hx.opened).toEqual([]);
    kill.mockRestore();
    await hx.terminals.killAllForTask(hx.t.id);
  });

  it('stops Finish before cleanup when the push hangs past its timeout', async () => {
    const hx = await prHarness();
    commitFile(hx.t.worktreePath, 'mine.txt', 'a\n', 'Mine');
    const hook = path.join(hx.repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, '#!/bin/sh\nsleep 10\n');
    chmodSync(hook, 0o755);
    (hx.services.git as { pushTimeoutMs: number }).pushTimeoutMs = 300;
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      'Pull request not created: git push timed out after 0.3 s (a credential prompt may be waiting)',
    );
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(hx.create).not.toHaveBeenCalled();
  });

  it('stops Finish before cleanup when the PR call fails', async () => {
    const hx = await prHarness();
    hx.create.mockRejectedValue(
      new AdoError('unauthorized', '_apis/git', CODE_WRITE_DENIED, 403),
    );
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      'Pull request not created: The token cannot create pull requests (needs Code: Read & write)',
    );
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(existsSync(hx.t.worktreePath)).toBe(true);
  });

  it('refuses a PR when pull requests are unavailable, and cleans up nothing', async () => {
    const hx = await prHarness('https://github.com/contoso/R.git');
    const push = vi.spyOn(hx.services.git, 'push');
    await expect(hx.h['tasks:finish'](hx.t.id, finishWithPr)).rejects.toThrow(
      'Pull request not created: origin is not an Azure Repos URL',
    );
    expect(push).not.toHaveBeenCalled();
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(true);
  });

  it('refreshes the PR status, keeping the stored ref when the refresh fails', async () => {
    const hx = await prHarness();
    expect(await hx.h['tasks:prStatus'](hx.t.id)).toBeNull();
    await hx.h['tasks:finish'](hx.t.id, finishWithPr);
    const refresh = vi.spyOn(hx.client, 'pullRequest').mockResolvedValue({
      pullRequestId: 7,
      status: 'completed',
      isDraft: false,
    });
    const next = await hx.h['tasks:prStatus'](hx.t.id);
    expect(refresh).toHaveBeenCalledWith('P', 'repo-1', 7);
    expect(next).toMatchObject({ id: 7, status: 'completed', isDraft: false });
    expect(hx.store.state.tasks[0].pullRequest).toEqual(next);
    refresh.mockRejectedValue(new Error('offline'));
    expect(await hx.h['tasks:prStatus'](hx.t.id)).toEqual(next);
  });

  it('refreshes and stores an extra workspace PR', async () => {
    const hx = await prHarness();
    const pr = {
      id: 8,
      url: 'u',
      repositoryId: 'rid2',
      project: 'P',
      repo: 'api',
      status: 'active' as const,
      isDraft: true,
    };
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces.push({
        id: 'x1',
        repoId: hx.t.repoId,
        branch: 'feature/x',
        worktreePath: '/w/x',
        baseRef: 'origin/main',
        baseSha: null,
        source: 'detected',
        summary: null,
        pullRequest: pr,
        reopen: null,
        dropped: false,
      });
    });
    const refresh = vi.spyOn(hx.client, 'pullRequest').mockResolvedValue({
      pullRequestId: 8,
      status: 'completed',
      isDraft: false,
    });
    const next = await hx.h['tasks:prStatus'](hx.t.id, 'x1');
    expect(refresh).toHaveBeenCalledWith('P', 'rid2', 8);
    expect(next).toMatchObject({ id: 8, status: 'completed' });
    expect(hx.store.state.tasks[0].extraWorkspaces[0].pullRequest).toEqual(
      next,
    );
    expect(hx.store.state.tasks[0].pullRequest).toBeNull();
  });

  it('refreshes a workspace PR through its own repo connection, not the task one', async () => {
    const hx = await prHarness();
    const other = await hx.connections.save({
      organizationUrl: 'https://dev.azure.com/other',
      project: 'Q',
      pat: 'p',
    });
    const pr = {
      id: 8,
      url: 'u',
      repositoryId: 'rid2',
      project: 'P',
      repo: 'api',
      status: 'active' as const,
      isDraft: true,
    };
    await hx.store.update((st) => {
      st.tasks[0].connectionId = other.id;
      st.tasks[0].extraWorkspaces.push({
        id: 'x1',
        repoId: hx.t.repoId,
        branch: 'feature/x',
        worktreePath: '/w/x',
        baseRef: 'origin/main',
        baseSha: null,
        source: 'detected',
        summary: null,
        pullRequest: pr,
        reopen: null,
        dropped: false,
      });
    });
    const own = vi.spyOn(hx.client, 'pullRequest').mockResolvedValue({
      pullRequestId: 8,
      status: 'completed',
      isDraft: false,
    });
    const taskClient = vi.spyOn(
      hx.services.trackers.client(other.id),
      'pullRequest',
    );
    await hx.h['tasks:prStatus'](hx.t.id, 'x1');
    expect(own).toHaveBeenCalledWith('P', 'rid2', 8);
    expect(taskClient).not.toHaveBeenCalled();
  });

  it('finishChecks still reports unpushed commits as a count', async () => {
    const hx = await prHarness();
    commitFile(hx.t.worktreePath, 'feature.txt', 'a\n', 'Add the feature');
    const checks = await hx.h['tasks:finishChecks'](hx.t.id);
    expect(checks.unpushed).toBe(1);
    expect(checks.runningTerminals).toBe(0);
  });
});

describe('handlers: task-level connection', () => {
  it('stores the repo connection on the task when it is created', async () => {
    const hx = await harness();
    const { t } = await linkedTask(hx);
    expect(t.connectionId).toBe(
      hx.services.repos.get(hx.added.id).connectionId,
    );
    expect(t.connectionId).not.toBeNull();
  });

  it('refreshes the PR status through the task connection', async () => {
    const hx = await harness();
    const { t } = await linkedTask(hx);
    const client = hx.services.trackers.client(t.connectionId!);
    const refresh = vi.spyOn(client, 'pullRequest').mockResolvedValue({
      pullRequestId: 7,
      status: 'completed',
      isDraft: false,
    });
    await hx.store.update((st) => {
      st.tasks[0].pullRequest = {
        id: 7,
        url: 'u',
        repositoryId: 'repo-1',
        project: 'P',
        repo: 'R',
        status: 'active',
        isDraft: true,
      };
    });
    await hx.h['repos:setConnection'](hx.added.id, null);
    expect(await hx.h['tasks:prStatus'](t.id)).toMatchObject({
      status: 'completed',
    });
    expect(refresh).toHaveBeenCalled();
  });
});

describe('handlers: finish every workspace of a task', () => {
  const HOME_REMOTE = 'https://dev.azure.com/contoso/P/_git/Web';
  const opts = {
    closeTerminals: true,
    removeWorktree: true,
    deleteBranch: true,
  };

  /** A task in `webshop` (home, origin Web) plus worktrees on its branch in more repos, joined by a scan. */
  async function multiHarness(
    extras: { name: string; org?: string }[],
    over: Partial<CreateTaskInput> = {},
  ) {
    const hx = await harness();
    commitFile(hx.repo, '.gitignore', '.env\n');
    addOrigin(hx.repo);
    const c = await hx.connections.save({
      organizationUrl: 'https://dev.azure.com/contoso',
      project: 'P',
      pat: 'p',
    });
    await hx.h['repos:setConnection'](hx.added.id, c.id);
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](
      hx.input({
        baseRef: 'origin/main',
        openShell: false,
        // The copied .env is ignored, as in a real repo; no generated files.
        commands: [],
        ...over,
      }),
    );
    await done;
    const remotes = new Map<string, string>([[hx.repo, HOME_REMOTE]]);
    const repos: {
      name: string;
      path: string;
      wt: string;
      bare: string;
      connectionId: string;
    }[] = [];
    for (const e of extras) {
      const p = makeRepo(e.name);
      const bare = addOrigin(p);
      const org = e.org ?? 'contoso';
      const conn =
        org === 'contoso'
          ? c
          : await hx.connections.save({
              organizationUrl: `https://dev.azure.com/${org}`,
              project: 'P',
              pat: 'p',
            });
      const added = await hx.h['repos:add'](p);
      await hx.h['repos:setConnection'](added.id, conn.id);
      remotes.set(p, `https://dev.azure.com/${org}/P/_git/${e.name}`);
      const wt = path.join(path.dirname(p), `${e.name}-wt`);
      git(p, 'worktree', 'add', '-q', '-b', t.branch, wt, 'origin/main');
      repos.push({ name: e.name, path: p, wt, bare, connectionId: conn.id });
    }
    vi.spyOn(hx.services.git, 'remoteUrl').mockImplementation(
      async (cwd) => remotes.get(cwd) ?? null,
    );
    await hx.h['tasks:scanWorkspaces'](t.id);
    const ids = hx.store.state.tasks[0].extraWorkspaces.map((w) => w.id);
    expect(ids).toHaveLength(extras.length);
    // One fake Azure Repos per connection: PRs it created are found again as active.
    const created: { connectionId: string; repo: string; args: unknown }[] = [];
    const clients = new Map<
      string,
      ReturnType<typeof hx.services.trackers.client>
    >();
    for (const id of new Set([c.id, ...repos.map((r) => r.connectionId)])) {
      const client = hx.services.trackers.client(id);
      clients.set(id, client);
      vi.spyOn(client, 'repositoryId').mockImplementation(
        async (_p, name) => `id-${name}`,
      );
      vi.spyOn(client, 'findActivePullRequest').mockImplementation(
        async (_p, repositoryId) => {
          const n = created.findIndex(
            (x) => x.connectionId === id && `id-${x.repo}` === repositoryId,
          );
          return n < 0
            ? null
            : { pullRequestId: 100 + n, status: 'active', isDraft: true };
        },
      );
      vi.spyOn(client, 'createPullRequest').mockImplementation(
        async (_p, repositoryId, args) => {
          created.push({
            connectionId: id,
            repo: repositoryId.slice(3),
            args,
          });
          return {
            pullRequestId: 100 + created.length - 1,
            status: 'active',
            isDraft: true,
          };
        },
      );
    }
    const push = vi.spyOn(hx.services.git, 'push');
    return { ...hx, c, t, repos, ids, created, clients, push };
  }

  const ws = (hx: { store: TaskStore }, id: string) =>
    hx.store.state.tasks[0].extraWorkspaces.find((w) => w.id === id)!;

  it('checks every workspace: changes, PR target and whether the PR links the work item', async () => {
    const hx = await multiHarness([
      { name: 'api' },
      { name: 'docs', org: 'fabrikam' },
    ]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    const checks = await hx.h['tasks:finishChecks'](hx.t.id);
    expect(checks.workspaces.map((w) => w.workspaceId)).toEqual([
      'home',
      ...hx.ids,
    ]);
    expect(checks.workspaces[0]).toMatchObject({
      repoName: 'webshop',
      branch: hx.t.branch,
      missing: false,
      commits: 0,
      pr: { available: true, target: 'main', linksWorkItem: true },
    });
    expect(checks.workspaces[1]).toMatchObject({
      repoName: 'api',
      commits: 1,
      unpushed: 1,
      pr: { available: true, target: 'main', linksWorkItem: true },
    });
    expect(checks.workspaces[2].pr).toMatchObject({
      available: true,
      linksWorkItem: false,
    });
    expect(await hx.h['tasks:prAvailability'](hx.t.id, hx.ids[0])).toEqual({
      available: true,
      reason: null,
      target: 'main',
    });
  });

  it('books the Time spent once and writes it once for a multi-repo Finish', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    await hx.settings.save({ ...hx.settings.get(), writeTimeToAdo: true });
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    const client = hx.clients.get(hx.c.id)!;
    vi.spyOn(client, 'workItemEstimate').mockResolvedValue({
      type: 'User Story',
      originalEstimate: null,
      remainingWork: 5,
      completedWork: 1,
    });
    vi.spyOn(client, 'workItemTypeFields').mockResolvedValue([
      {
        type: 'User Story',
        fields: [
          'Microsoft.VSTS.Scheduling.RemainingWork',
          'Microsoft.VSTS.Scheduling.CompletedWork',
        ],
      },
    ]);
    const write = vi
      .spyOn(client, 'updateWorkItemFields')
      .mockResolvedValue(undefined as never);
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      bookedSeconds: 7200,
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: hx.ids[0], action: 'push' },
      ],
    });
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(task.time).toMatchObject({
      bookedSeconds: 7200,
      writtenHours: 2,
      syncError: null,
    });
    expect(task.openPeriods.at(-1)?.end).toBe(task.finishedAt);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe(48231);
  });

  it('refuses to push a repo whose branch adds a stored value, per row, unless confirmed', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    await hx.services.secrets.save({
      scope: 'all',
      name: 'UAT_KEY',
      givenTo: ['run'],
      values: { uat: { value: 'uat-api-key-77aa0c' } },
    });
    commitFile(hx.repos[0].wt, 'api.txt', 'key=uat-api-key-77aa0c\n', 'API');
    const finish = (confirmLeak?: boolean) =>
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        // The page-wide flag is the single-repo one: a row is confirmed on its own.
        confirmLeak: true,
        workspaces: [
          { workspaceId: 'home', action: 'drop' },
          {
            workspaceId: hx.ids[0],
            action: 'push',
            ...(confirmLeak ? { confirmLeak } : {}),
          },
        ],
      });
    await expect(finish()).rejects.toThrow(LEAK_IN_BRANCH);
    expect(hx.push).not.toHaveBeenCalled();
    const row = (await hx.h['tasks:finishResults'](hx.t.id))!.find(
      (r) => r.workspaceId === hx.ids[0],
    )!;
    expect(row).toMatchObject({ ok: false, leak: 'found', pushed: false });
    expect(row.error).toContain(LEAK_IN_BRANCH);
    expect(JSON.stringify(row)).not.toMatch(/UAT_KEY|uat-api/);
    await finish(true);
    expect(hx.push).toHaveBeenCalledTimes(1);
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('books nothing when a multi-repo Finish fails, and once on its retry', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    const push = hx.push.mockRejectedValueOnce(new Error('rejected'));
    const finish = () =>
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        bookedSeconds: 3600,
        workspaces: [
          { workspaceId: 'home', action: 'drop' },
          { workspaceId: hx.ids[0], action: 'push' },
        ],
      });
    await expect(finish()).rejects.toThrow('rejected');
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(hx.store.state.tasks[0].time).toBeNull();
    expect(hx.store.state.tasks[0].openPeriods.at(-1)?.end).toBeNull();
    await finish();
    expect(push).toHaveBeenCalledTimes(2);
    expect(hx.store.state.tasks[0]).toMatchObject({
      status: 'done',
      time: { bookedSeconds: 3600 },
    });
  });

  it('drops the home without a push and opens a PR for the repo with changes', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    // The copied .env is gitignored, so the home still counts as unchanged.
    expect(existsSync(path.join(hx.t.worktreePath, '.env'))).toBe(true);
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      deleteBranch: false,
      removeWorktree: false,
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: hx.ids[0], action: 'pr' },
      ],
      prSummaries: { [hx.ids[0]]: '## Why\nThe API needed it.' },
    });
    expect(hx.push.mock.calls.map((c) => c[0])).toEqual([hx.repos[0].wt]);
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(task.homeDropped).toBe(true);
    // A dropped workspace is always removed, whatever the global options say.
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(
      false,
    );
    expect(existsSync(hx.repos[0].wt)).toBe(true);
    expect(git(hx.repos[0].bare, 'branch', '--list', hx.t.branch)).toContain(
      hx.t.branch,
    );
    expect(hx.created).toHaveLength(1);
    expect(hx.created[0]).toMatchObject({
      repo: 'api',
      args: { source: hx.t.branch, target: 'main', workItemId: 48231 },
    });
    expect(
      (hx.created[0].args as { description: string }).description,
    ).not.toContain('AI cost');
    // The row's own summary heads its PR.
    expect(
      (hx.created[0].args as { description: string }).description,
    ).toContain('\n\n## Why\nThe API needed it.\n\n## Commits\n');
    expect(ws(hx, hx.ids[0]).pullRequest).toMatchObject({
      id: 100,
      repo: 'api',
      url: 'https://dev.azure.com/contoso/P/_git/api/pullrequest/100',
    });
    expect(ws(hx, hx.ids[0]).summary).toMatchObject({
      pushed: true,
      commitCount: 1,
    });
    expect(task.pullRequest).toBeNull();
    expect(hx.opened).toEqual([
      'https://dev.azure.com/contoso/P/_git/api/pullrequest/100',
    ]);
  });

  it("never removes a worktree that is not on the task's branch, nor deletes its branch", async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    const tools = makeRepo('tools');
    const toolsWt = path.join(path.dirname(tools), 'tools-dev');
    git(tools, 'worktree', 'add', '-q', '-b', 'dev', toolsWt);
    const dev = await hx.h['tasks:addWorkspace'](hx.t.id, toolsWt);
    expect(dev.branch).toBe('dev');
    const rows = (action: 'drop' | 'keep') => ({
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'keep' as const },
        { workspaceId: hx.ids[0], action: 'keep' as const },
        { workspaceId: dev.id, action },
      ],
    });
    await expect(hx.h['tasks:finish'](hx.t.id, rows('drop'))).rejects.toThrow(
      "tools is not on this task's branch (dev): it is kept as is",
    );
    expect(hx.store.state.tasks[0].status).toBe('ready');
    expect(existsSync(toolsWt)).toBe(true);

    // Remove worktrees and delete branches is on: the task's own go, `dev` stays.
    await hx.h['tasks:finish'](hx.t.id, rows('keep'));
    expect(hx.store.state.tasks[0].status).toBe('done');
    expect(existsSync(hx.t.worktreePath)).toBe(false);
    expect(existsSync(hx.repos[0].wt)).toBe(false);
    expect(existsSync(toolsWt)).toBe(true);
    expect(await new GitClient().branchExists(tools, 'dev')).toBe(true);
  });

  it('keeps where a push could not sign in on the failed row', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    const hint = {
      host: 'dev.azure.com',
      connectionId: hx.c.id,
      path: hx.repos[0].wt,
    };
    hx.push.mockImplementation(async () => {
      throw new GitAuthError(
        "fatal: could not read Password for 'https://dev.azure.com/contoso': terminal prompts disabled",
        'fatal: could not read Password',
        hint,
      );
    });
    await expect(
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        workspaces: [
          { workspaceId: 'home', action: 'drop' },
          { workspaceId: hx.ids[0], action: 'pr' },
        ],
      }),
    ).rejects.toThrow(/could not read Password/);
    const rows = await hx.h['tasks:finishResults'](hx.t.id);
    expect(rows?.find((r) => r.workspaceId === hx.ids[0])).toMatchObject({
      ok: false,
      auth: hint,
    });
    expect(rows?.find((r) => r.workspaceId === 'home')?.auth).toBeUndefined();
  });

  it('stops before cleanup when one PR fails, and a retry neither pushes again nor duplicates the PR', async () => {
    const hx = await multiHarness([{ name: 'api' }, { name: 'docs' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    commitFile(hx.repos[1].wt, 'docs.txt', 'a\n', 'Docs change');
    const realPush = GitClient.prototype.push;
    let failDocs = true;
    hx.push.mockImplementation(
      async function (this: GitClient, cwd, remote, branch) {
        if (failDocs && cwd === hx.repos[1].wt)
          throw new Error('! [rejected] (fetch first)');
        return realPush.call(this, cwd, remote, branch);
      },
    );
    const finishAll = {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'drop' as const },
        { workspaceId: hx.ids[0], action: 'pr' as const },
        { workspaceId: hx.ids[1], action: 'pr' as const },
      ],
    };
    await expect(hx.h['tasks:finish'](hx.t.id, finishAll)).rejects.toThrow(
      /^Pull request not created for docs: [^]*rejected/,
    );
    const failed = hx.store.state.tasks[0];
    expect(failed.status).toBe('ready');
    expect(failed.homeDropped).toBe(false);
    expect(ws(hx, hx.ids[0]).pullRequest).toMatchObject({ repo: 'api' });
    expect(ws(hx, hx.ids[1]).pullRequest).toBeNull();
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(existsSync(hx.repos[0].wt)).toBe(true);
    expect(existsSync(hx.repos[1].wt)).toBe(true);
    expect(hx.opened).toEqual([
      'https://dev.azure.com/contoso/P/_git/api/pullrequest/100',
    ]);
    expect(await hx.h['tasks:finishResults'](hx.t.id)).toEqual([
      {
        workspaceId: 'home',
        action: 'drop',
        ok: true,
        pushed: false,
        pullRequest: null,
        error: null,
      },
      {
        workspaceId: hx.ids[0],
        action: 'pr',
        ok: true,
        pushed: true,
        pullRequest: {
          id: 100,
          url: 'https://dev.azure.com/contoso/P/_git/api/pullrequest/100',
          linked: false,
        },
        error: null,
      },
      {
        workspaceId: hx.ids[1],
        action: 'pr',
        ok: false,
        pushed: false,
        pullRequest: null,
        error: '! [rejected] (fetch first)',
      },
    ]);

    failDocs = false;
    hx.push.mockClear();
    // The api PR was completed meanwhile: the retry keeps the stored one instead of making a second.
    const findActive = vi.mocked(
      hx.clients.get(hx.c.id)!.findActivePullRequest,
    );
    findActive.mockClear();
    await hx.h['tasks:finish'](hx.t.id, finishAll);
    expect(findActive.mock.calls.map((c) => c[1])).toEqual(['id-docs']);
    expect(hx.push.mock.calls.map((c) => c[0])).toEqual([hx.repos[1].wt]);
    expect(hx.created.map((x) => x.repo)).toEqual(['api', 'docs']);
    expect(ws(hx, hx.ids[0]).pullRequest).toMatchObject({ id: 100 });
    expect(ws(hx, hx.ids[1]).pullRequest).toMatchObject({ id: 101 });
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(task.homeDropped).toBe(true);
    expect(existsSync(hx.repos[1].wt)).toBe(false);
  });

  it('finishes without the PR for the failed row only', async () => {
    const hx = await multiHarness([{ name: 'api' }, { name: 'docs' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    commitFile(hx.repos[1].wt, 'docs.txt', 'a\n', 'Docs change');
    vi.mocked(hx.clients.get(hx.c.id)!.createPullRequest).mockRejectedValueOnce(
      new Error('boom'),
    );
    const rows = (api: 'pr' | 'keep') => ({
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'drop' as const },
        { workspaceId: hx.ids[0], action: api },
        { workspaceId: hx.ids[1], action: 'pr' as const },
      ],
    });
    await expect(hx.h['tasks:finish'](hx.t.id, rows('pr'))).rejects.toThrow(
      'Pull request not created for api: boom',
    );
    expect(ws(hx, hx.ids[1]).pullRequest).toMatchObject({ repo: 'docs' });
    // Finish without PR keeps api; docs' PR exists already, so it is linked, not created again.
    await hx.h['tasks:finish'](hx.t.id, rows('keep'));
    expect(hx.created.map((x) => x.repo)).toEqual(['docs']);
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(ws(hx, hx.ids[0]).pullRequest).toBeNull();
    expect(existsSync(hx.repos[0].wt)).toBe(false);
    expect(existsSync(hx.repos[1].wt)).toBe(false);
  });

  it('refuses to drop a repo that got changes after the checks, and cleans up nothing', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    const checks = await hx.h['tasks:finishChecks'](hx.t.id);
    expect(checks.workspaces[0]).toMatchObject({ commits: 0, uncommitted: [] });
    // Claude keeps working while the Finish page is open.
    commitFile(hx.t.worktreePath, 'late.txt', 'a\n', 'Late change');
    await expect(
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        workspaces: [
          { workspaceId: 'home', action: 'drop' },
          { workspaceId: hx.ids[0], action: 'push' },
        ],
      }),
    ).rejects.toThrow('webshop has changes now; reload Finish');
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('ready');
    expect(task.homeDropped).toBe(false);
    expect(existsSync(hx.t.worktreePath)).toBe(true);
    expect(existsSync(hx.repos[0].wt)).toBe(true);
    expect(await new GitClient().branchExists(hx.repo, hx.t.branch)).toBe(true);
    // Uncommitted files count as changes too.
    git(hx.t.worktreePath, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(path.join(hx.t.worktreePath, 'draft.txt'), 'x');
    await expect(
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        workspaces: [{ workspaceId: 'home', action: 'drop' }],
      }),
    ).rejects.toThrow('webshop has changes now; reload Finish');
    expect(existsSync(path.join(hx.t.worktreePath, 'draft.txt'))).toBe(true);
  });

  it('a folder that cannot be removed yet waits for the background cleanup; the rest finishes (#115)', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    vi.spyOn(hx.services.git, 'worktreeRemove').mockRejectedValueOnce(
      new Error('folder locked'),
    );
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'keep' },
        { workspaceId: hx.ids[0], action: 'push' },
      ],
    });
    const task = hx.store.state.tasks[0];
    expect(task.status).toBe('done');
    expect(task.pendingCleanup).toEqual([
      expect.objectContaining({
        workspaceId: 'home',
        worktreePath: hx.t.worktreePath,
        error: 'folder locked',
        code: 'other',
      }),
    ]);
    expect(existsSync(hx.repos[0].wt)).toBe(false);
    expect(task.summary).toMatchObject({ commitCount: 0 });
    expect(ws(hx, hx.ids[0]).summary).toMatchObject({
      commitCount: 1,
      pushed: true,
    });
  });

  it('a PR stored by an earlier Finish (before a Reopen) is looked up again, not kept', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces[0].pullRequest = {
        id: 3,
        url: 'https://dev.azure.com/contoso/P/_git/api/pullrequest/3',
        repositoryId: 'id-api',
        project: 'P',
        repo: 'api',
        status: 'completed',
        isDraft: false,
      };
    });
    const findActive = vi.mocked(
      hx.clients.get(hx.c.id)!.findActivePullRequest,
    );
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: hx.ids[0], action: 'pr' },
      ],
    });
    expect(findActive.mock.calls.map((c) => c[1])).toEqual(['id-api']);
    expect(hx.created.map((x) => x.repo)).toEqual(['api']);
    expect(ws(hx, hx.ids[0]).pullRequest).toMatchObject({
      id: 100,
      status: 'active',
    });
  });

  it('a branch whose base cannot be found is never "no changes", and is not dropped', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    await hx.store.update((st) => {
      st.tasks[0].extraWorkspaces[0].baseRef = 'no-such-base';
      st.tasks[0].extraWorkspaces[0].baseSha = null;
    });
    const checks = await hx.h['tasks:finishChecks'](hx.t.id);
    expect(checks.workspaces[0].baseKnown).toBe(true);
    expect(checks.workspaces[1]).toMatchObject({
      baseKnown: false,
      uncommitted: [],
    });
    await expect(
      hx.h['tasks:finish'](hx.t.id, {
        ...opts,
        workspaces: [
          { workspaceId: 'home', action: 'keep' },
          { workspaceId: hx.ids[0], action: 'drop' },
        ],
      }),
    ).rejects.toThrow('api has changes now; reload Finish');
    expect(existsSync(hx.repos[0].wt)).toBe(true);
  });

  it('a scan error does not break the Finish checks', async () => {
    const hx = await harness(fakeCrypto(), {
      workspaces: {
        scan: async () => {
          throw new Error('scan exploded');
        },
      } as unknown as WorkspaceDetector,
    });
    const done = hx.setupDone();
    const t = await hx.h['tasks:create'](hx.input({ openShell: false }));
    await done;
    const checks = await hx.h['tasks:finishChecks'](t.id);
    expect(checks.workspaces.map((w) => w.workspaceId)).toEqual(['home']);
  });

  it('a push-only row pushes without a PR, and records it as pushed', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.repos[0].wt, 'api.txt', 'a\n', 'API change');
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: hx.ids[0], action: 'push' },
      ],
    });
    expect(hx.created).toEqual([]);
    expect(git(hx.repos[0].bare, 'branch', '--list', hx.t.branch)).toContain(
      hx.t.branch,
    );
    expect(ws(hx, hx.ids[0]).summary).toMatchObject({ pushed: true });
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('a worktree removed by hand is reported missing and skipped by Finish', async () => {
    const hx = await multiHarness([{ name: 'api' }]);
    commitFile(hx.t.worktreePath, 'web.txt', 'a\n', 'Web change');
    rmSync(hx.repos[0].wt, { recursive: true, force: true });
    const checks = await hx.h['tasks:finishChecks'](hx.t.id);
    expect(checks.workspaces[1]).toMatchObject({
      workspaceId: hx.ids[0],
      missing: true,
      uncommitted: [],
      commits: 0,
    });
    const view = (await hx.h['tasks:list']())[0];
    expect(view.extraWorkspaces.map((w) => w.id)).toEqual(hx.ids);
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'pr' },
        { workspaceId: hx.ids[0], action: 'pr' },
      ],
    });
    expect(hx.push.mock.calls.map((c) => c[0])).toEqual([hx.t.worktreePath]);
    expect(hx.created.map((x) => x.repo)).toEqual(['Web']);
    expect(hx.store.state.tasks[0].status).toBe('done');
  });

  it('a repo in another organization gets a PR without the work item link, naming it instead', async () => {
    const hx = await multiHarness([{ name: 'docs', org: 'fabrikam' }], {
      workItem: {
        id: '48231',
        type: 'User Story',
        title: 'Show estimated delivery date',
        url: 'https://dev.azure.com/contoso/P/_workitems/edit/48231',
      },
    });
    commitFile(hx.repos[0].wt, 'docs.txt', 'a\n', 'Docs change');
    await hx.h['tasks:finish'](hx.t.id, {
      ...opts,
      workspaces: [
        { workspaceId: 'home', action: 'drop' },
        { workspaceId: hx.ids[0], action: 'pr' },
      ],
    });
    expect(hx.created).toHaveLength(1);
    expect(hx.created[0].connectionId).toBe(hx.repos[0].connectionId);
    const args = hx.created[0].args as {
      workItemId: number | null;
      description: string;
    };
    expect(args.workItemId).toBeNull();
    expect(args.description).toContain(
      'Work item: https://dev.azure.com/contoso/P/_workitems/edit/48231',
    );
    expect(ws(hx, hx.ids[0]).pullRequest).toMatchObject({
      url: 'https://dev.azure.com/fabrikam/P/_git/docs/pullrequest/100',
    });
  });
});
