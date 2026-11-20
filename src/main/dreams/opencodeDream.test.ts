import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DREAM_PROTECTED,
  dreamArgs,
  dreamEnv,
  isProtectedPath,
  otherModels,
} from './opencodeDream';

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

  it('switches off project config and blanks the inherited extra config and permission', () => {
    const env = dreamEnv(
      {
        A: '1',
        OPENCODE_PERMISSION: '{"bash":"allow"}',
        OPENCODE_CONFIG: '/x/opencode.json',
      },
      { model: MODEL, worktree: WORKTREE, dataDir: DATA },
    );
    expect(env.A).toBe('1');
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    // Empty, not left out: the spawn helpers spread process.env first, and OpenCode 1.19.3 reads these two only for
    // truthiness, so empty is unset.
    expect(env.OPENCODE_PERMISSION).toBe('');
    expect(env.OPENCODE_CONFIG).toBe('');
  });

  it("points OPENCODE_CONFIG_DIR at the user's real global config folder, as OpenCode computes it, never empty", () => {
    const opts = { model: MODEL, worktree: WORKTREE, dataDir: DATA };
    expect(
      dreamEnv(
        { OPENCODE_CONFIG_DIR: '/x/cfg', XDG_CONFIG_HOME: '/x/xdg' },
        opts,
      ).OPENCODE_CONFIG_DIR,
    ).toBe(path.join('/x/xdg', 'opencode'));
    // An empty XDG_CONFIG_HOME is unset to OpenCode (`||`).
    expect(
      dreamEnv({ OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: '' }, opts)
        .OPENCODE_CONFIG_DIR,
    ).toBe(path.join(os.homedir(), '.config', 'opencode'));
  });

  it('sets PWD to the worktree: `opencode run` takes its folder from PWD before the process folder', () =>
    expect(
      dreamEnv(
        { PWD: '/' },
        { model: MODEL, worktree: WORKTREE, dataDir: DATA },
      ).PWD,
    ).toBe(WORKTREE));

  // Making a symlink needs extra rights on Windows.
  it.skipIf(process.platform === 'win32')(
    'resolves a worktree reached through a symlink to its real path, for PWD and the edit patterns',
    () => {
      const real = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'dream-')),
      );
      fs.mkdirSync(path.join(real, 'worktree'));
      fs.mkdirSync(path.join(real, 'data'));
      const link = `${real}-link`;
      fs.symlinkSync(real, link);
      try {
        const env = dreamEnv(
          {},
          {
            model: MODEL,
            worktree: path.join(link, 'worktree'),
            dataDir: path.join(link, 'data'),
          },
        );
        expect(env.PWD).toBe(path.join(real, 'worktree'));
        const { permission } = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
        expect(permission.edit).toHaveProperty(['../data/**'], 'allow');
        expect(permission.external_directory).toHaveProperty(
          [`${path.join(real, 'data')}/**`],
          'allow',
        );
      } finally {
        fs.rmSync(link);
        fs.rmSync(real, { recursive: true });
      }
    },
  );

  it('gives the build agent rules equal to the top-level ones', () => {
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
    expect(decide(permission, 'edit', '//server/share/x.md')).toBe('deny');
  });

  it("never lets an edit write OpenCode's own config, at the root or deeper, in the worktree or the data folder", () => {
    const { permission } = config();
    for (const p of [
      'opencode.json',
      'opencode.jsonc',
      '.opencode/opencode.json',
      '.opencode/plugin/x.ts',
      '.opencode/agent/build.md',
      'packages/a/opencode.json',
      'packages/a/.opencode/plugin/x.ts',
      '../data/opencode.json',
      '../data/.opencode/plugin/x.ts',
    ])
      expect(decide(permission, 'edit', p), p).toBe('deny');
    expect(decide(permission, 'edit', 'docs/opencode.json.md')).toBe('allow');
  });

  it('never lets an edit write a hook script, at any depth', () => {
    const { permission } = config();
    for (const p of [
      'hooks/pre-commit',
      '.apm/hooks/format.json',
      '.apm/hooks/scripts/run.sh',
      'packages/a/.husky/hooks/x',
    ])
      expect(decide(permission, 'edit', p), p).toBe('deny');
    expect(decide(permission, 'edit', '.apm/rules/hooks.md')).toBe('allow');
  });

  it('lets a read-only run (the check) edit the data folder only, nothing in the worktree', () => {
    const env = dreamEnv(
      {},
      {
        model: MODEL,
        worktree: WORKTREE,
        dataDir: DATA,
        readOnlyWorktree: true,
      },
    );
    const c = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as ReturnType<
      typeof config
    >;
    const { permission } = c;
    expect(c.agent.build.permission).toEqual(permission);
    for (const p of [
      'README.md',
      '.apm/skills/x/SKILL.md',
      'a/b/c.md',
      '../other/x.md',
      'D:/elsewhere/x.md',
      '//server/share/x.md',
      '../data/opencode.json',
    ])
      expect(decide(permission, 'edit', p), p).toBe('deny');
    expect(decide(permission, 'edit', '../data/report.json')).toBe('allow');
    expect(decide(permission, 'edit', '../data/sub/notes.md')).toBe('allow');
    expect(decide(permission, 'read', 'src/a.ts')).toBe('allow');
    expect(
      decide(permission, 'external_directory', `${DATA}/report.json`),
    ).toBe('allow');
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

describe('isProtectedPath', () => {
  it("names OpenCode's config files and folder at any depth, in any case", () => {
    expect(DREAM_PROTECTED).toEqual([
      'opencode.json',
      'opencode.jsonc',
      '.opencode',
      'hooks',
    ]);
    for (const p of [
      'opencode.json',
      'opencode.jsonc',
      '.opencode',
      '.opencode/plugin/x.ts',
      'a/b/.opencode/agent/x.md',
      'a/opencode.json',
      'OpenCode.JSON',
      '.OpenCode/plugin/x.ts',
      'a\\.opencode\\x.ts',
      'hooks/pre-commit',
      '.apm/hooks/format.json',
      '.apm/Hooks/run.sh',
    ])
      expect(isProtectedPath(p), p).toBe(true);
    for (const p of [
      'README.md',
      '.apm/skills/x/SKILL.md',
      'docs/opencode.json.md',
      'opencode',
      '.apm/rules/hooks.md',
      'src/use-hooks/x.ts',
    ])
      expect(isProtectedPath(p), p).toBe(false);
  });
});
