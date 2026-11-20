import { describe, expect, it } from 'vitest';
import { dreamArgs, dreamEnv, otherModels } from './opencodeDream';

const MODEL = 'zai/glm-5.3';
const WORKTREE = '/u/Shellie/dreams/2026-11-20-1/worktree';
const DATA = '/u/Shellie/dreams/2026-11-20-1/data';

type Rules = Record<string, unknown>;
const config = (o: { worktree?: string; dataDir?: string } = {}) =>
  JSON.parse(
    dreamEnv({}, { model: MODEL, worktree: WORKTREE, dataDir: DATA, ...o })
      .OPENCODE_CONFIG_CONTENT,
  ) as {
    model: string;
    small_model: string;
    default_agent: string;
    agent: Record<
      string,
      { model?: string; disable?: boolean; permission?: Rules }
    >;
    permission: Rules;
    mcp: unknown;
  };

/** OpenCode 1.19.3's own matching: `*` matches anything (slashes too), `?` one character, the last matching rule wins. */
const wildcard = (text: string, pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/\\/g, '/')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    's',
  ).test(text.replace(/\\/g, '/'));
const decide = (rules: Rules, tool: string, target: string) => {
  let action: unknown = 'ask';
  for (const [perm, v] of Object.entries(rules)) {
    if (!wildcard(tool, perm)) continue;
    const patterns = typeof v === 'string' ? { '*': v } : (v as Rules);
    for (const [p, a] of Object.entries(patterns))
      if (wildcard(target, p)) action = a;
  }
  return action;
};

describe('dreamArgs', () => {
  it('runs with json events, the dream title and the chosen model', () =>
    expect(dreamArgs(MODEL, 'propose')).toEqual([
      'run',
      '--format',
      'json',
      '--title',
      'Shellie dream: propose',
      '-m',
      MODEL,
    ]));
  it('refuses a model that is not a valid provider/model', () => {
    expect(() => dreamArgs('glm-5.3', 'check')).toThrow();
    expect(() => dreamArgs('a/b" & calc', 'test')).toThrow();
  });
});

describe('dreamEnv', () => {
  it('keeps the base env and replaces an inherited inline config', () => {
    const env = dreamEnv(
      { A: '1', OPENCODE_CONFIG_CONTENT: '{"permission":{"bash":"allow"}}' },
      { model: MODEL, worktree: WORKTREE, dataDir: DATA },
    );
    expect(env.A).toBe('1');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).permission.bash).toBe(
      'deny',
    );
  });

  it('pins every model key to the chosen model and the agent to build', () => {
    const c = config();
    expect(c.model).toBe(MODEL);
    expect(c.small_model).toBe(MODEL);
    expect(c.default_agent).toBe('build');
    for (const name of [
      'build',
      'plan',
      'general',
      'explore',
      'title',
      'summary',
      'compaction',
    ])
      expect(c.agent[name].model).toBe(MODEL);
  });

  it('switches off subagents, title generation and MCP servers', () => {
    const c = config();
    expect(c.agent.general.disable).toBe(true);
    expect(c.agent.explore.disable).toBe(true);
    expect(c.agent.title.disable).toBe(true);
    expect(c.permission.task).toBe('deny');
    expect(c.mcp).toEqual({});
  });

  it('denies shell, web and every tool it does not name', () => {
    const { permission } = config();
    for (const tool of ['bash', 'webfetch', 'websearch', 'task'])
      expect(permission[tool]).toBe('deny');
    expect(Object.keys(permission)[0]).toBe('*');
    expect(permission['*']).toBe('deny');
    expect(decide(permission, 'github_create_issue', '*')).toBe('deny');
    expect(decide(permission, 'bash', 'ls')).toBe('deny');
    for (const tool of ['read', 'glob', 'grep', 'list'])
      expect(decide(permission, tool, 'src/a.ts')).toBe('allow');
  });

  it('gives the build agent the same rules, so a repo agent setting cannot loosen them', () => {
    const c = config();
    expect(c.agent.build.permission).toEqual(c.permission);
  });

  it('lets edits through in the worktree and the data folder only (edit paths are relative to the worktree)', () => {
    const { permission } = config();
    const edit = permission.edit as Rules;
    expect(Object.entries(edit)[0]).toEqual(['*', 'deny']);
    expect(decide(permission, 'edit', 'README.md')).toBe('allow');
    expect(decide(permission, 'edit', '.apm/skills/x/SKILL.md')).toBe('allow');
    expect(decide(permission, 'edit', '../data/report.md')).toBe('allow');
    expect(decide(permission, 'edit', '../data/sub/notes.md')).toBe('allow');
    expect(decide(permission, 'edit', '../other/x.md')).toBe('deny');
    expect(decide(permission, 'edit', '../../../../etc/hosts')).toBe('deny');
    expect(decide(permission, 'edit', 'D:/elsewhere/x.md')).toBe('deny');
  });

  it('opens only the data folder outside the worktree', () => {
    const { permission } = config();
    const ext = permission.external_directory as Rules;
    expect(Object.entries(ext)[0]).toEqual(['*', 'deny']);
    expect(decide(permission, 'external_directory', `${DATA}/*`)).toBe('allow');
    expect(decide(permission, 'external_directory', `${DATA}/sub/*`)).toBe(
      'allow',
    );
    expect(
      decide(permission, 'external_directory', '/u/Shellie/dreams/*'),
    ).toBe('deny');
    expect(decide(permission, 'external_directory', '/etc/*')).toBe('deny');
  });

  it('writes Windows paths with forward slashes', () => {
    const { permission } = config({
      worktree: 'C:\\Users\\me\\AppData\\Shellie\\dreams\\d1\\worktree',
      dataDir: 'C:\\Users\\me\\AppData\\Shellie\\dreams\\d1\\data',
    });
    expect(permission.edit).toHaveProperty(['../data/**'], 'allow');
    expect(permission.external_directory).toHaveProperty(
      ['C:/Users/me/AppData/Shellie/dreams/d1/data/**'],
      'allow',
    );
  });

  it('refuses a data folder that is, holds or sits inside the worktree', () => {
    expect(() => config({ dataDir: WORKTREE })).toThrow();
    expect(() => config({ dataDir: `${WORKTREE}/report` })).toThrow();
    expect(() => config({ dataDir: '/u/Shellie/dreams' })).toThrow();
  });

  it('refuses a model that is not a valid provider/model', () =>
    expect(() =>
      dreamEnv({}, { model: 'glm', worktree: WORKTREE, dataDir: DATA }),
    ).toThrow());
});

describe('otherModels', () => {
  it('is empty when only the chosen model answered', () =>
    expect(otherModels([MODEL, MODEL], MODEL)).toEqual([]));
  it('names the other models that answered, once each', () =>
    expect(
      otherModels([MODEL, 'opencode/big-pickle', 'opencode/big-pickle'], MODEL),
    ).toEqual(['opencode/big-pickle']));
  it('is not a pass when nobody answered', () =>
    expect(otherModels([], MODEL)).toEqual(['(none)']));
});
