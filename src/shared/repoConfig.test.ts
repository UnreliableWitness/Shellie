import { describe, expect, it } from 'vitest';
import { mergeConfig, OVERRIDE_KEYS } from './repoConfig';
import type { ShellieConfig } from './types';

const fileCfg: ShellieConfig = {
  base: 'origin/dev',
  branch: '{type}/{id}',
  copy: ['.env'],
  setup: ['npm ci'],
  run: { dev: 'npm start' },
  apm: ['claude'],
  found: true,
};
const none = new Set<never>();

describe('mergeConfig', () => {
  it('no file, no overrides: sources all default, base = repoBase', () => {
    const base: ShellieConfig = {
      base: 'origin/main',
      branch: 'x',
      copy: [],
      setup: [],
      run: {},
      found: false,
    };
    const r = mergeConfig(base, {
      overrides: {},
      repoBase: 'origin/develop',
      fileKeys: none,
    });
    expect(r.config.base).toBe('origin/develop');
    for (const k of OVERRIDE_KEYS) expect(r.sources[k]).toBe('default');
  });

  it('file base wins over repoBase; source file', () => {
    const r = mergeConfig(fileCfg, {
      overrides: {},
      repoBase: 'origin/develop',
      fileKeys: new Set(['base']),
    });
    expect(r.config.base).toBe('origin/dev');
    expect(r.sources.base).toBe('file');
  });

  it('override wins over file; source override', () => {
    const r = mergeConfig(fileCfg, {
      overrides: {
        setup: ['yarn'],
        run: { a: 'b' },
        copy: ['.x'],
        branch: 'b/{id}',
        base: 'origin/o',
      },
      repoBase: null,
      fileKeys: new Set(['setup', 'run', 'copy', 'branch', 'base']),
    });
    expect(r.config).toMatchObject({
      setup: ['yarn'],
      run: { a: 'b' },
      copy: ['.x'],
      branch: 'b/{id}',
      base: 'origin/o',
    });
    for (const k of ['setup', 'run', 'copy', 'branch', 'base'] as const)
      expect(r.sources[k]).toBe('override');
  });

  it('override setup [] stays [] (not the default)', () => {
    const r = mergeConfig(fileCfg, {
      overrides: { setup: [] },
      repoBase: null,
      fileKeys: new Set(['setup']),
    });
    expect(r.config.setup).toEqual([]);
    expect(r.sources.setup).toBe('override');
  });

  it("apm 'auto' override removes apm", () => {
    const r = mergeConfig(fileCfg, {
      overrides: { apm: 'auto' },
      repoBase: null,
      fileKeys: new Set(['apm']),
    });
    expect('apm' in r.config).toBe(false);
    expect(r.sources.apm).toBe('override');
  });

  it('reviewCollapse override maps to config.reviewCollapse', () => {
    const r = mergeConfig(fileCfg, {
      overrides: { reviewCollapse: ['*.lock'] },
      repoBase: null,
      fileKeys: none,
    });
    expect(r.config.reviewCollapse).toEqual(['*.lock']);
    expect(r.sources.reviewCollapse).toBe('override');
  });
});
