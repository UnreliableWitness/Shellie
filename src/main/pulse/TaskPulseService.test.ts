import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PulseSnapshot } from '../../shared/pulse';
import type { PullRequestRef } from '../../shared/types';
import { AdoError, type RawPrDetail } from '../services/AdoClient';
import {
  TaskPulseService,
  type PulseClient,
  type PulseDeps,
} from './TaskPulseService';

const pr = (o: Partial<RawPrDetail> = {}): RawPrDetail => ({
  pullRequestId: 7,
  status: 'active',
  isDraft: false,
  creationDate: '2026-11-10T00:00:00Z',
  closedDate: null,
  mergeStatus: null,
  projectId: 'pid',
  createdById: 'me',
  webUrl: 'https://x/pr/7',
  reviewers: [],
  ...o,
});

type WS = ReturnType<PulseDeps['workspaces']>[number];
const ws = (n: number, o: Partial<WS> = {}): WS => ({
  taskId: `t${n}`,
  workspaceId: `w${n}`,
  branch: `b${n}`,
  openedAt: null,
  stored: null,
  ...o,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pulse-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(
  over: Partial<PulseDeps> = {},
  clientOver: Partial<Record<keyof PulseClient, unknown>> = {},
) {
  const calls = { me: 0, repositoryId: 0 };
  let inflight = 0;
  let maxInflight = 0;
  const client = {
    me: vi.fn(async () => {
      calls.me++;
      return 'me';
    }),
    repositoryId: vi.fn(async () => {
      calls.repositoryId++;
      return 'rid';
    }),
    pullRequestsForBranch: vi.fn(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return [pr()];
    }),
    policyEvaluations: vi.fn(async () => []),
    pullRequestStatuses: vi.fn(async () => []),
    pullRequestThreads: vi.fn(async () => []),
    ...clientOver,
  } as unknown as PulseClient;
  const onChanged = vi.fn();
  const link = vi.fn(async () => undefined);
  const onRefreshed = vi.fn();
  const deps: PulseDeps = {
    file: path.join(dir, 'pulse.json'),
    workspaces: () => [ws(1)],
    target: async () => ({ connectionId: 'c', project: 'P', repo: 'R' }),
    client: () => client,
    link,
    onChanged,
    onRefreshed,
    now: () => new Date('2026-11-18T12:00:00Z'),
    ...over,
  };
  return {
    svc: new TaskPulseService(deps),
    deps,
    client,
    calls,
    onChanged,
    link,
    onRefreshed,
    max: () => maxInflight,
  };
}

describe('TaskPulseService', () => {
  it('finds the PR, links it once and broadcasts once', async () => {
    const { svc, onChanged, link } = setup();
    const snap = await svc.refresh();
    expect(snap.tasks.t1[0].pr?.id).toBe(7);
    expect(onChanged).toHaveBeenCalledTimes(1);
    const ref: PullRequestRef = {
      id: 7,
      url: 'https://x/pr/7',
      repositoryId: 'rid',
      project: 'P',
      repo: 'R',
      status: 'active',
      isDraft: false,
    };
    expect(link).toHaveBeenCalledWith('t1', 'w1', ref);
  });

  it('fetches CI, statuses and threads for an active PR', async () => {
    const { svc, client } = setup();
    await svc.refresh();
    expect(client.policyEvaluations).toHaveBeenCalledTimes(1);
    expect(client.pullRequestStatuses).toHaveBeenCalledTimes(1);
    expect(client.pullRequestThreads).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'abandoned'] as const)(
    'skips the detail calls for a %s PR but still links it',
    async (status) => {
      const { svc, client, link } = setup(
        {},
        {
          pullRequestsForBranch: async () => [
            pr({ status, closedDate: '2026-11-17T00:00:00Z' }),
          ],
        },
      );
      const snap = await svc.refresh();
      expect(client.policyEvaluations).not.toHaveBeenCalled();
      expect(client.pullRequestStatuses).not.toHaveBeenCalled();
      expect(client.pullRequestThreads).not.toHaveBeenCalled();
      expect(link).toHaveBeenCalledWith(
        't1',
        'w1',
        expect.objectContaining({ id: 7, status }),
      );
      const p = snap.tasks.t1[0];
      expect(p.pr?.status).toBe(status);
      expect(p.ci).toBe('none');
      expect(p.unanswered).toBe(0);
    },
  );

  it('does not link or broadcast again when nothing changed', async () => {
    const stored: PullRequestRef = {
      id: 7,
      url: 'https://x/pr/7',
      repositoryId: 'rid',
      project: 'P',
      repo: 'R',
      status: 'active',
      isDraft: false,
    };
    const { svc, onChanged, link } = setup({
      workspaces: () => [ws(1, { stored })],
    });
    await svc.refresh();
    await svc.refresh();
    expect(link).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('skips a workspace without a target', async () => {
    const { svc, client } = setup({ target: async () => null });
    const snap = await svc.refresh();
    expect(snap.tasks.t1).toBeUndefined();
    expect(client.pullRequestsForBranch).not.toHaveBeenCalled();
  });

  it('gives a reopened task no PR and links nothing', async () => {
    const { svc, link } = setup(
      { workspaces: () => [ws(1, { openedAt: '2026-11-15T00:00:00Z' })] },
      {
        pullRequestsForBranch: async () => [
          pr({ status: 'completed', closedDate: '2026-11-12T00:00:00Z' }),
        ],
      },
    );
    const snap = await svc.refresh();
    expect(snap.tasks.t1[0].pr).toBeNull();
    expect(link).not.toHaveBeenCalled();
  });

  it('caches the repository id and asks for me once per refresh', async () => {
    const { svc, calls } = setup({ workspaces: () => [ws(1), ws(2)] });
    await svc.refresh();
    await svc.refresh();
    expect(calls.repositoryId).toBe(1);
    expect(calls.me).toBe(2);
  });

  it('keeps the previous pulse on an auth error and clears it on success', async () => {
    let fail = false;
    const { svc, onRefreshed } = setup(
      {},
      {
        pullRequestsForBranch: async () => {
          if (fail) throw new AdoError('unauthorized', '/x', 'nope', 401);
          return [pr()];
        },
      },
    );
    await svc.refresh();
    fail = true;
    const bad = await svc.refresh();
    expect(bad.error).toBe('auth');
    expect(bad.tasks.t1[0].pr?.id).toBe(7);
    expect(onRefreshed.mock.calls.at(-1)![0].errors).toContain('auth');
    fail = false;
    expect((await svc.refresh()).error).toBeNull();
  });

  it('lets a network error on one workspace not stop another', async () => {
    const { svc } = setup(
      { workspaces: () => [ws(1), ws(2)] },
      {
        pullRequestsForBranch: async (_p: string, _r: string, b: string) => {
          if (b === 'b1') throw new AdoError('unreachable', '/x', 'down');
          return [pr()];
        },
      },
    );
    const snap = await svc.refresh();
    expect(snap.tasks.t1).toBeUndefined();
    expect(snap.tasks.t2[0].pr?.id).toBe(7);
    expect(snap.error).toBeNull();
  });

  it('runs at most four lookups at once', async () => {
    const { svc, max } = setup({
      workspaces: () => Array.from({ length: 10 }, (_, i) => ws(i)),
    });
    await svc.refresh();
    expect(max()).toBeLessThanOrEqual(4);
    expect(max()).toBeGreaterThan(1);
  });

  it('returns the running refresh to a second caller', async () => {
    const { svc, client } = setup();
    const [a, b] = await Promise.all([svc.refresh(), svc.refresh()]);
    expect(a).toBe(b);
    expect(client.pullRequestsForBranch).toHaveBeenCalledTimes(1);
  });

  it('persists the snapshot for a new service on the same file', async () => {
    const first = setup();
    await first.svc.refresh();
    const second = setup();
    const snap: PulseSnapshot = await second.svc.get();
    expect(snap.tasks.t1[0].pr?.id).toBe(7);
  });

  it('drops tasks that are no longer open', async () => {
    let list = [ws(1), ws(2)];
    const { svc } = setup({ workspaces: () => list });
    await svc.refresh();
    list = [ws(2)];
    const snap = await svc.refresh();
    expect(Object.keys(snap.tasks)).toEqual(['t2']);
  });
});
