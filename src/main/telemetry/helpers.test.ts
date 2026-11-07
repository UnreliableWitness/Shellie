import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Handlers } from '../../shared/ipc';
import { NoopTelemetry, type Telemetry } from './AppInsightsClient';
import {
  adoOperation,
  changedKeys,
  forwardRendererTelemetry,
  installId,
  pathOperation,
  sensitiveValues,
  telemetryOptedOut,
  timedFetch,
  trackHandlerFailures,
} from './helpers';
import { PerfStats } from './perf';

function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const t: Telemetry = {
    ...NoopTelemetry,
    event: (...a) => calls.push(['event', ...a]),
    pageView: (...a) => calls.push(['pageView', ...a]),
    exception: (...a) => calls.push(['exception', ...a]),
    exceptionParts: (...a) => calls.push(['exceptionParts', ...a]),
    dependency: (...a) => calls.push(['dependency', ...a]),
  };
  return { t, calls };
}

describe('adoOperation', () => {
  it('replaces a repository name in a git route', () => {
    expect(
      adoOperation(
        'https://dev.azure.com/acme/Other/_apis/git/repositories/secret-repo/pullrequests?x=1',
      ).name,
    ).toBe('GET _apis/git/repositories/{repo}/pullrequests');
    expect(
      adoOperation(
        'https://dev.azure.com/acme/Other/_apis/git/repositories/0f8fad5b-d9cb-469f-a165-70867728950e/pullrequests/7',
      ).name,
    ).toBe('GET _apis/git/repositories/{id}/pullrequests/{id}');
  });
  it('keeps only the API route, with ids replaced', () => {
    expect(
      adoOperation(
        'https://dev.azure.com/acme/Secret%20Project/_apis/wit/workitems/42?api-version=7.1',
      ),
    ).toEqual({
      name: 'GET _apis/wit/workitems/{id}',
      target: 'dev.azure.com',
    });
    expect(
      adoOperation('https://acme.visualstudio.com/p/_apis/wit/wiql', 'post'),
    ).toEqual({ name: 'POST _apis/wit/wiql', target: 'visualstudio.com' });
    expect(adoOperation('https://dev.azure.com/acme/p').name).toBe(
      'GET (other)',
    );
  });
});

describe('timedFetch', () => {
  it('records a dependency per request without the URL', async () => {
    const { t, calls } = recorder();
    const f = timedFetch(
      t,
      (async () =>
        new Response('', { status: 401 })) as unknown as typeof fetch,
    );
    await f('https://dev.azure.com/acme/p/_apis/projects/p');
    const [kind, dep] = calls[0] as [string, Record<string, unknown>];
    expect(kind).toBe('dependency');
    expect(dep).toMatchObject({
      name: 'GET _apis/projects/{project}',
      target: 'dev.azure.com',
      resultCode: '401',
      success: false,
    });
    expect(JSON.stringify(dep)).not.toContain('acme');
  });

  it('records a failed request and rethrows', async () => {
    const { t, calls } = recorder();
    const f = timedFetch(t, (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch);
    await expect(f('https://dev.azure.com/a/_apis/x')).rejects.toThrow(
      'ENOTFOUND',
    );
    expect(calls[0][1]).toMatchObject({ resultCode: 'error', success: false });
  });

  it('names a request by its path on a fixed target, never the host or query', async () => {
    const { t, calls } = recorder();
    const f = timedFetch(
      t,
      (async () => new Response('{}')) as unknown as typeof fetch,
      pathOperation('cost-server'),
    );
    await f('https://costs.acme.example/api/v1/hello?email=me%40acme.example');
    await f('https://costs.acme.example/api/v1/records/42', { method: 'post' });
    expect(calls.map((c) => c[1])).toMatchObject([
      { name: 'GET /api/v1/hello', target: 'cost-server', success: true },
      { name: 'POST /api/v1/records/{id}', target: 'cost-server' },
    ]);
    expect(JSON.stringify(calls)).not.toContain('acme');
  });
});

describe('trackHandlerFailures', () => {
  it('reports the channel of a rejected call, not its arguments, and rethrows', async () => {
    const { t, calls } = recorder();
    const wrapped = trackHandlerFailures(
      {
        'repos:add': async () => {
          throw new Error('nope');
        },
        'repos:list': async () => [],
      } as unknown as Handlers,
      t,
    );
    await expect(wrapped['repos:add']('/Users/x/secret')).rejects.toThrow(
      'nope',
    );
    expect(await wrapped['repos:list']()).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual({ source: 'ipc', channel: 'repos:add' });
  });

  it('times every call under its channel', async () => {
    const stats = new PerfStats();
    const wrapped = trackHandlerFailures(
      {
        'repos:add': async () => {
          throw new Error('nope');
        },
        'repos:list': async () => [],
      } as unknown as Handlers,
      NoopTelemetry,
      stats,
    );
    await wrapped['repos:list']();
    await wrapped['repos:list']();
    await expect(wrapped['repos:add']('x')).rejects.toThrow();
    const sent: unknown[][] = [];
    stats.report({ ...NoopTelemetry, metric: (...a) => sent.push(a) });
    expect(
      sent.map((m) => [m[0], m[2], (m[3] as { count: number }).count]),
    ).toEqual([
      ['ipc.ms', { op: 'repos:list', outcome: 'ok' }, 2],
      ['ipc.ms', { op: 'repos:add', outcome: 'failed' }, 1],
    ]);
  });
});

describe('forwardRendererTelemetry', () => {
  it('forwards valid messages tagged as renderer and ignores malformed ones', () => {
    const { t, calls } = recorder();
    forwardRendererTelemetry(
      { type: 'event', name: 'focus.toggled', props: { on: true } },
      t,
    );
    forwardRendererTelemetry({ type: 'pageView', name: 'settings' }, t);
    forwardRendererTelemetry(
      { type: 'event', name: 'renderer.longTasks', measurements: { count: 2 } },
      t,
    );
    forwardRendererTelemetry(
      { type: 'event', name: 'bad', measurements: { count: 'two' } },
      t,
    );
    forwardRendererTelemetry(
      { type: 'exception', errorType: 'TypeError', message: 'x', stack: 's' },
      t,
    );
    forwardRendererTelemetry({ type: 'event', name: 'has spaces' }, t);
    forwardRendererTelemetry(
      { type: 'event', name: 'ok', props: { a: {} } },
      t,
    );
    forwardRendererTelemetry('junk', t);
    expect(calls).toEqual([
      ['event', 'focus.toggled', { on: true, process: 'renderer' }, undefined],
      ['pageView', 'settings', { process: 'renderer' }],
      ['event', 'renderer.longTasks', { process: 'renderer' }, { count: 2 }],
      [
        'exceptionParts',
        { errorType: 'TypeError', message: 'x', stack: 's' },
        { process: 'renderer' },
      ],
    ]);
  });
});

describe('installId', () => {
  it('creates a random id once and reuses it', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-tel-'));
    const a = await installId(dir);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(await installId(dir)).toBe(a);
    expect(readFileSync(path.join(dir, 'telemetry-id'), 'utf8')).toBe(a);
  });
});

describe('changedKeys and sensitiveValues', () => {
  it('lists changed keys only', () => {
    expect(changedKeys({ a: 1, b: 2, c: 3 }, { a: 1, b: 5, c: 4 })).toEqual([
      'b',
      'c',
    ]);
  });
  it('collects brain names and paths', () => {
    const v = sensitiveValues({
      repos: [],
      tasks: [],
      connections: [],
      brains: [{ name: 'Acme', path: '/b' }],
    });
    expect(v).toContain('Acme');
    expect(v).toContain('/b');
  });
  it('collects repo, task, work item and connection identifiers', () => {
    const v = sensitiveValues({
      repos: [{ name: 'webshop', path: '/src/webshop' }],
      tasks: [
        {
          name: '',
          branch: 'feature/1-x',
          slug: '1-x',
          worktreePath: '/src/webshop.worktrees/1-x',
          workItem: { title: 'Secret title' },
        },
      ],
      connections: [
        {
          name: 'Acme',
          organizationUrl: 'https://dev.azure.com/acme-org/',
          project: 'Proj',
          user: 'jane@acme.test',
        },
      ],
      username: 'jane',
    });
    expect(v).toEqual(
      expect.arrayContaining([
        'webshop',
        '/src/webshop',
        'feature/1-x',
        'Secret title',
        'acme-org',
        'Proj',
        'jane@acme.test',
        'jane',
      ]),
    );
    expect(v).not.toContain('');
  });
  it('adds the project and repo of stored pull requests and extra values', () => {
    const v = sensitiveValues({
      repos: [],
      tasks: [
        {
          name: '',
          branch: 'b',
          slug: 's',
          worktreePath: '/w',
          workItem: null,
          pullRequest: { project: 'Other Project', repo: 'azure-repo' },
        },
      ],
      connections: [],
      extra: ['ssh-project', 'ssh-repo'],
    });
    expect(v).toEqual(
      expect.arrayContaining([
        'Other Project',
        'azure-repo',
        'ssh-project',
        'ssh-repo',
      ]),
    );
  });
});

describe('telemetryOptedOut', () => {
  it('honours both opt-out variables', () => {
    expect(telemetryOptedOut({ SHELLIE_TELEMETRY: '0' })).toBe(true);
    expect(telemetryOptedOut({ MIAC_TELEMETRY: '0' })).toBe(true);
    expect(telemetryOptedOut({})).toBe(false);
  });
});
