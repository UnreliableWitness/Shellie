import { describe, expect, it } from 'vitest';
import {
  AppInsightsClient,
  formatDuration,
  parseConnectionString,
  type ClientOptions,
  type Envelope,
} from './AppInsightsClient';

const IKEY = '00000000-1111-2222-3333-444444444444';
const CS = `InstrumentationKey=${IKEY};IngestionEndpoint=https://westeurope-5.in.applicationinsights.azure.com/;LiveEndpoint=https://westeurope.livediagnostics.monitor.azure.com/`;

function setup(over: Partial<ClientOptions> = {}) {
  const posts: { url: string; body: Envelope[] }[] = [];
  let enabled = true;
  const client = new AppInsightsClient({
    connectionString: CS,
    enabled: () => enabled,
    now: () => Date.UTC(2026, 9, 15, 12, 0, 0),
    flushIntervalMs: 0,
    home: '/Users/dries',
    context: {
      appVersion: '1.2.3',
      os: 'darwin',
      osVersion: '25.6.0',
      arch: 'arm64',
      electronVersion: '44.7.2',
      packaged: true,
      installId: 'install-1',
      sessionId: 'session-1',
    },
    fetch: (async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
    ...over,
  });
  return {
    client,
    posts,
    setEnabled: (v: boolean) => {
      enabled = v;
    },
  };
}

describe('parseConnectionString', () => {
  it('reads the key and the ingestion endpoint', () => {
    expect(parseConnectionString(CS)).toEqual({
      iKey: IKEY,
      endpoint: 'https://westeurope-5.in.applicationinsights.azure.com',
    });
  });
  it('falls back to the global endpoint and rejects a string without key', () => {
    expect(parseConnectionString(`InstrumentationKey=${IKEY}`)?.endpoint).toBe(
      'https://dc.services.visualstudio.com',
    );
    expect(parseConnectionString('IngestionEndpoint=https://x/')).toBeNull();
    expect(() => setup({ connectionString: 'nonsense' })).toThrow();
  });
});

describe('formatDuration', () => {
  it('formats as a TimeSpan', () => {
    expect(formatDuration(1234)).toBe('00:00:01.234');
    expect(formatDuration(3_723_004)).toBe('01:02:03.004');
    expect(formatDuration(90_000_000)).toBe('1.01:00:00.000');
  });
});

describe('AppInsightsClient', () => {
  it('posts event envelopes with common context to v2/track', async () => {
    const { client, posts } = setup();
    client.event('task.created', { workItem: true, commands: 2 }, { ms: 5 });
    await client.flush();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(
      'https://westeurope-5.in.applicationinsights.azure.com/v2/track',
    );
    expect(posts[0].body).toEqual([
      {
        name: `Microsoft.ApplicationInsights.${IKEY.replace(/-/g, '')}.Event`,
        time: '2026-10-15T12:00:00.000Z',
        iKey: IKEY,
        tags: {
          'ai.application.ver': '1.2.3',
          'ai.cloud.role': 'Shellie',
          'ai.device.os': 'darwin',
          'ai.device.osVersion': '25.6.0',
          'ai.device.type': 'PC',
          'ai.user.id': 'install-1',
          'ai.session.id': 'session-1',
          'ai.internal.sdkVersion': 'shellie-ai:1',
        },
        data: {
          baseType: 'EventData',
          baseData: {
            ver: 2,
            name: 'task.created',
            properties: {
              arch: 'arm64',
              electron: '44.7.2',
              packaged: 'true',
              workItem: 'true',
              commands: '2',
            },
            measurements: { ms: 5 },
          },
        },
      },
    ]);
  });

  it('builds page view, metric, exception and dependency envelopes', async () => {
    const { client, posts } = setup();
    client.pageView('settings');
    client.metric('setup.step.worktree', 812);
    client.exception(new TypeError('boom'), { source: 'ipc' });
    client.dependency({
      name: 'GET _apis/wit/wiql',
      target: 'dev.azure.com',
      durationMs: 250,
      resultCode: '200',
      success: true,
    });
    await client.flush();
    const [pv, metric, ex, dep] = posts[0].body;
    expect(pv.data.baseType).toBe('PageviewData');
    expect(pv.data.baseData.name).toBe('settings');
    expect(metric.data.baseData.metrics).toEqual([
      { name: 'setup.step.worktree', kind: 0, value: 812, count: 1 },
    ]);
    expect(ex.data.baseType).toBe('ExceptionData');
    expect(ex.data.baseData).toMatchObject({
      severityLevel: 3,
      exceptions: [
        { typeName: 'TypeError', message: 'boom', hasFullStack: true },
      ],
      properties: { source: 'ipc' },
    });
    expect(dep.data.baseData).toMatchObject({
      name: 'GET _apis/wit/wiql',
      target: 'dev.azure.com',
      duration: '00:00:00.250',
      resultCode: '200',
      success: true,
      type: 'HTTP',
    });
  });

  it('sends a summary metric as one aggregation and a warning at level 2', async () => {
    const { client, posts } = setup();
    client.metric(
      'ipc.ms',
      90,
      { op: 'tasks:list' },
      { count: 3, min: 10, max: 50 },
    );
    client.exception(new Error('logged'), undefined, 'warning');
    await client.flush();
    const [metric, ex] = posts[0].body;
    expect(metric.data.baseData.metrics).toEqual([
      { name: 'ipc.ms', kind: 1, value: 90, count: 3, min: 10, max: 50 },
    ]);
    expect(ex.data.baseData.severityLevel).toBe(2);
  });

  it('sends the same error object once', async () => {
    const { client, posts } = setup();
    const e = new Error('twice');
    client.exception(e, { source: 'ipc' });
    client.exception(e, { source: 'log' });
    client.exception(new Error('twice'));
    await client.flush();
    expect(posts[0].body).toHaveLength(2);
  });

  it('batches: one request per batchSize items, sent as soon as a batch is full', async () => {
    const { client, posts } = setup({ batchSize: 3 });
    for (let i = 0; i < 7; i++) client.event(`e${i}`);
    // Two full batches went out on their own; one item waits.
    expect(client.pending).toBe(1);
    await client.flush();
    expect(posts.map((p) => p.body.length)).toEqual([3, 3, 1]);
  });

  it('flushes on a timer after the first item', async () => {
    const { client, posts } = setup({ flushIntervalMs: 10 });
    client.event('a');
    client.event('b');
    await new Promise((r) => setTimeout(r, 40));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toHaveLength(2);
    expect(client.pending).toBe(0);
  });

  it('caps the queue and reports how many items were dropped', async () => {
    const { client, posts } = setup({ maxQueue: 2, batchSize: 100 });
    for (let i = 0; i < 5; i++) client.event(`e${i}`);
    expect(client.pending).toBe(2);
    await client.flush();
    const body = posts[0].body;
    expect(body).toHaveLength(3);
    expect(body[2].data.baseData.metrics).toEqual([
      { name: 'telemetry.dropped', kind: 0, value: 3, count: 1 },
    ]);
  });

  it('sends nothing when opted out, and drops what was queued when the user opts out', async () => {
    const { client, posts, setEnabled } = setup();
    client.event('before');
    setEnabled(false);
    client.event('while-off');
    await client.flush();
    expect(posts).toHaveLength(0);
    expect(client.pending).toBe(0);
    setEnabled(true);
    client.event('after');
    await client.flush();
    expect(posts.map((p) => p.body.map((e) => e.data.baseData.name))).toEqual([
      ['after'],
    ]);
  });

  it('never throws or retries when sending fails', async () => {
    let calls = 0;
    const { client } = setup({
      fetch: (async () => {
        calls++;
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });
    client.event('a');
    await expect(client.flush()).resolves.toBeUndefined();
    await client.flush();
    expect(calls).toBe(1);
  });

  it('scrubs home paths, user folders and sensitive values from messages, stacks and properties', async () => {
    const { client, posts } = setup({
      sensitive: () => ['webshop', 'Show estimated delivery date'],
    });
    const e = new Error(
      'Branch feature/x already exists in webshop (/Users/dries/src/webshop)',
    );
    e.stack = [
      'Error: Branch feature/x already exists in webshop',
      '    at f (/Users/dries/src/shellie/main.cjs:1:2)',
      '    at g (C:\\Users\\Dries\\AppData\\Local\\shellie\\app-1.0.0\\resources\\app.asar\\main.cjs:3:4)',
      '    at h (/home/someone/x.js:5:6)',
    ].join('\n');
    client.exception(e);
    client.event('notice', {
      message:
        'Could not find "Show estimated delivery date" at https://dev.azure.com/acme',
    });
    await client.flush();
    const [ex, ev] = posts[0].body;
    const detail = (
      ex.data.baseData.exceptions as { message: string; stack: string }[]
    )[0];
    expect(detail.message).toBe(
      'Branch feature/x already exists in <redacted> (~/src/<redacted>)',
    );
    expect(detail.stack).not.toMatch(/dries|someone/i);
    expect(detail.stack).toContain('at f (~/src/shellie/main.cjs:1:2)');
    expect(detail.stack).toContain('at g (~\\AppData\\Local');
    expect(detail.stack).toContain('at h (~/x.js:5:6)');
    expect(
      (ev.data.baseData.properties as Record<string, string>).message,
    ).toBe('Could not find "<redacted>" at <url>');
  });

  it('scrubs ssh remotes from git output', async () => {
    const { client, posts } = setup();
    client.exception(
      new Error(
        'fatal: Could not read from remote repository git@ssh.dev.azure.com:v3/acme/Proj/repo and ssh://git@host.example:22/x/y.git (mail me@x.org)',
      ),
    );
    await client.flush();
    const detail = (
      posts[0].body[0].data.baseData.exceptions as { message: string }[]
    )[0];
    expect(detail.message).toBe(
      'fatal: Could not read from remote repository <url> and <url> (mail <email>)',
    );
  });
});
