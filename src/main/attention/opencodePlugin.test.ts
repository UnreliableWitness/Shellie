import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPENCODE_PLUGIN_SOURCE,
  lostConfig,
  opencodeConfigContent,
} from './opencodePlugin';

type Hooks = { event?: (i: { event: unknown }) => Promise<void> };
type PluginFn = (input: unknown) => Promise<Hooks>;

const ENV = {
  SHELLIE_ATTENTION_URL: 'http://127.0.0.1:1/v1/attention',
  SHELLIE_ATTENTION_TOKEN: 'tok',
  SHELLIE_TERMINAL_ID: 'term-1',
};

let plugin: PluginFn;
const posts: unknown[] = [];

beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-oc-'));
  const file = path.join(dir, `p${Date.now()}${Math.random()}.mjs`);
  writeFileSync(file, OPENCODE_PLUGIN_SOURCE);
  const mod = (await import(pathToFileURL(file).href)) as Record<
    string,
    unknown
  >;
  expect(Object.keys(mod)).toEqual(['ShellieAttention']);
  plugin = mod.ShellieAttention as PluginFn;
  posts.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (
        url: string,
        init: { headers: Record<string, string>; body: string },
      ) => {
        posts.push({
          url,
          token: init.headers['x-shellie-token'],
          ...JSON.parse(init.body),
        });
        return new Response('{}');
      },
    ),
  );
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const fire = async (hooks: Hooks, type: string, properties: unknown) =>
  hooks.event?.({ event: { type, properties } });

describe('ShellieAttention plugin', () => {
  it('maps permission, question, status and error events', async () => {
    const h = await plugin({});
    await fire(h, 'permission.asked', {
      sessionID: 's',
      permission: 'bash',
      patterns: ['rm -rf dist'],
    });
    await fire(h, 'permission.replied', { sessionID: 's', reply: 'once' });
    await fire(h, 'question.asked', { sessionID: 's', questions: [] });
    await fire(h, 'session.status', {
      sessionID: 's',
      status: { type: 'busy' },
    });
    await fire(h, 'session.status', {
      sessionID: 's',
      status: { type: 'idle' },
    });
    await fire(h, 'session.idle', { sessionID: 's' });
    await fire(h, 'session.error', { sessionID: 's', error: { name: 'Boom' } });
    expect(posts).toEqual([
      expect.objectContaining({
        token: 'tok',
        terminalId: 'term-1',
        state: 'blocked',
        kind: 'permission',
        message: 'bash: rm -rf dist',
      }),
      expect.objectContaining({ state: 'working' }),
      expect.objectContaining({ state: 'blocked', kind: 'question' }),
      expect.objectContaining({ state: 'working' }),
      expect.objectContaining({ state: 'done' }),
      expect.objectContaining({
        state: 'done',
        kind: 'error',
        message: 'Boom',
      }),
    ]);
  });

  it('lets a child session block and unblock, but ignores its status', async () => {
    const h = await plugin({});
    await fire(h, 'session.created', {
      sessionID: 'c',
      info: { id: 'c', parentID: 's' },
    });
    await fire(h, 'session.status', {
      sessionID: 'c',
      status: { type: 'idle' },
    });
    expect(posts).toEqual([]);
    await fire(h, 'permission.asked', { sessionID: 'c', permission: 'edit' });
    await fire(h, 'permission.asked', { sessionID: 'c', permission: 'bash' });
    await fire(h, 'permission.replied', { sessionID: 'c' });
    expect(posts).toEqual([
      expect.objectContaining({
        state: 'blocked',
        kind: 'permission',
        message: 'edit',
      }),
      expect.objectContaining({
        state: 'blocked',
        kind: 'permission',
        message: 'bash',
      }),
      expect.objectContaining({ state: 'working' }),
    ]);
  });

  it('does nothing outside Shellie and survives fetch failures', async () => {
    vi.stubEnv('SHELLIE_ATTENTION_URL', '');
    expect(await plugin({})).toEqual({});
    vi.stubEnv('SHELLIE_ATTENTION_URL', ENV.SHELLIE_ATTENTION_URL);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    const h = await plugin({});
    await expect(
      fire(h, 'session.idle', { sessionID: 's' }),
    ).resolves.toBeUndefined();
  });
});

describe('opencodeConfigContent', () => {
  it('creates or appends the plugin entry', () => {
    expect(opencodeConfigContent(undefined, '/p.js')).toBe(
      '{"plugin":["/p.js"]}',
    );
    expect(
      JSON.parse(
        opencodeConfigContent('{"model":"x","plugin":["a"]}', '/p.js')!,
      ),
    ).toEqual({ model: 'x', plugin: ['a', '/p.js'] });
  });

  it('leaves invalid content alone', () => {
    expect(opencodeConfigContent('not json', '/p.js')).toBeUndefined();
    expect(opencodeConfigContent('[1]', '/p.js')).toBeUndefined();
  });
});

describe('opencodeConfigContent instructions', () => {
  it("adds the shellie run instructions file next to the developer's own", () => {
    expect(
      JSON.parse(opencodeConfigContent(undefined, '/p.js', '/run.md')!),
    ).toEqual({ plugin: ['/p.js'], instructions: ['/run.md'] });
    expect(
      JSON.parse(
        opencodeConfigContent(
          '{"instructions":["AGENTS.md"]}',
          '/p.js',
          '/run.md',
        )!,
      ),
    ).toEqual({ plugin: ['/p.js'], instructions: ['AGENTS.md', '/run.md'] });
    expect(opencodeConfigContent(undefined, '/p.js')).toBe(
      '{"plugin":["/p.js"]}',
    );
  });
});

describe('opencodeConfigContent deny', () => {
  it('is unchanged without paths', () => {
    expect(opencodeConfigContent(undefined, '/p.js', undefined, [])).toBe(
      opencodeConfigContent(undefined, '/p.js'),
    );
  });

  it('adds permission deny entries', () => {
    const c = JSON.parse(
      opencodeConfigContent(undefined, '/p.js', undefined, ['.env'])!,
    );
    expect(c.permission.read).toEqual({ '.env': 'deny' });
    expect(c.permission.bash['cat .env*']).toBe('deny');
  });

  it("keeps the developer's own permissions, turning a plain action into a pattern map", () => {
    const c = JSON.parse(
      opencodeConfigContent(
        '{"permission":{"read":"allow","bash":{"git *":"allow"},"edit":"ask"}}',
        '/p.js',
        undefined,
        ['.env'],
      )!,
    );
    expect(c.permission.edit).toBe('ask');
    expect(c.permission.read).toEqual({ '*': 'allow', '.env': 'deny' });
    expect(c.permission.bash['git *']).toBe('allow');
    expect(c.permission.bash['type .env*']).toBe('deny');
  });
});

describe('opencodeConfigContent without the plugin', () => {
  it('still carries the deny entries, and nothing at all without them', () => {
    expect(
      JSON.parse(opencodeConfigContent(undefined, null, undefined, ['.env'])!),
    ).toEqual({
      permission: expect.objectContaining({ read: { '.env': 'deny' } }),
    });
    expect(
      JSON.parse(
        opencodeConfigContent('{"model":"x"}', null, undefined, ['.env'])!,
      ).model,
    ).toBe('x');
    expect(opencodeConfigContent(undefined, null)).toBeUndefined();
    expect(opencodeConfigContent('{"model":"x"}', null)).toBeUndefined();
  });

  it('is undefined when the developer value is not JSON, which the caller can report', () => {
    expect(
      opencodeConfigContent('nope', null, undefined, ['.env']),
    ).toBeUndefined();
  });
});

describe('opencodeConfigContent brain', () => {
  it('lets the tab read the brain folder and denies editing it', () => {
    const c = JSON.parse(
      opencodeConfigContent(undefined, '/p.js', undefined, [], '/b')!,
    );
    expect(c.permission.external_directory).toEqual({ '/b/**': 'allow' });
    expect(c.permission.edit).toEqual({ '/b/**': 'deny' });
    expect(c.permission.read).toBeUndefined();
  });

  it("puts the brain's edit deny after the developer's own edit rules, which stay", () => {
    const c = JSON.parse(
      opencodeConfigContent(
        '{"permission":{"edit":{"/b/**":"allow","*":"allow"},"external_directory":"ask"}}',
        null,
        undefined,
        ['.env'],
        '/b',
      )!,
    );
    expect(Object.entries(c.permission.edit)).toEqual([
      ['*', 'allow'],
      ['/b/**', 'deny'],
    ]);
    expect(c.permission.external_directory).toEqual({
      '*': 'ask',
      '/b/**': 'allow',
    });
    expect(c.permission.read).toEqual({ '.env': 'deny' });
  });

  it("denies editing the brain by its path from the tab's folder, which is how OpenCode matches edit rules", () => {
    const c = JSON.parse(
      opencodeConfigContent(undefined, null, undefined, [], '/b/acme', [
        '/w/t1',
        '/private/w/t1',
      ])!,
    );
    expect(c.permission.external_directory).toEqual({ '/b/acme/**': 'allow' });
    // The absolute deny stays too: it costs nothing and covers a later OpenCode that matches absolute patterns.
    expect(Object.entries(c.permission.edit)).toEqual([
      ['../../b/acme/**', 'deny'],
      ['../../../b/acme/**', 'deny'],
      ['/b/acme/**', 'deny'],
    ]);
  });

  it('writes a Windows brain folder with forward slashes, from the tab and absolute, also on another drive', () => {
    const c = JSON.parse(
      opencodeConfigContent(undefined, null, undefined, [], 'C:\\b\\acme', [
        'C:\\w\\t1',
        'D:\\w\\t2',
      ])!,
    );
    expect(c.permission.external_directory).toEqual({
      'C:/b/acme/**': 'allow',
    });
    expect(Object.entries(c.permission.edit)).toEqual([
      ['../../b/acme/**', 'deny'],
      ['C:/b/acme/**', 'deny'],
    ]);
    expect(JSON.stringify(c.permission)).not.toContain('\\\\');
  });

  it('denies a brain inside the worktree by its folder in it', () => {
    const c = JSON.parse(
      opencodeConfigContent(undefined, null, undefined, [], '/w/t1/brain', [
        '/w/t1',
      ])!,
    );
    expect(Object.entries(c.permission.edit)).toEqual([
      ['brain/**', 'deny'],
      ['/w/t1/brain/**', 'deny'],
    ]);
  });

  it("never denies a worktree's own files when the worktree is inside the brain", () => {
    for (const [brain, worktree] of [
      ['/b', '/b/wt'],
      ['/b', '/b'],
      ['C:\\b', 'C:\\b\\wt'],
    ]) {
      const c = JSON.parse(
        opencodeConfigContent(undefined, null, undefined, [], brain, [
          worktree,
        ])!,
      );
      expect(c.permission.edit ?? {}).toEqual({});
    }
  });

  it('keeps a plain edit action as the catch-all before the deny', () => {
    const c = JSON.parse(
      opencodeConfigContent(
        '{"permission":{"edit":"ask"}}',
        null,
        undefined,
        [],
        '/b',
      )!,
    );
    expect(Object.entries(c.permission.edit)).toEqual([
      ['*', 'ask'],
      ['/b/**', 'deny'],
    ]);
  });
});

describe('lostConfig', () => {
  it('names what a tab loses, never "0 secret files"', () => {
    expect(lostConfig(2, false)).toBe('not applied: 2 secret file denies');
    expect(lostConfig(1, true)).toBe(
      "not applied: 1 secret file deny, the brain folder's read access and edit deny",
    );
    expect(lostConfig(0, true)).toBe(
      "not applied: the brain folder's read access and edit deny",
    );
    expect(lostConfig(0, false)).toBe('not applied: the attention plugin');
  });
});
