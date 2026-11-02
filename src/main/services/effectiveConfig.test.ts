import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RepoSchema, type Repo, type Task } from '../../shared/types';
import { loadEffectiveConfig } from './effectiveConfig';
import { ShellieConfigError } from './ShellieConfig';

const tmpDirs: string[] = [];
const dir = () => {
  const d = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), 'shellie-eff-')),
  );
  tmpDirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

const repoAt = (p: string, over: Partial<Repo> = {}): Repo =>
  RepoSchema.parse({
    id: 'r1',
    name: path.basename(p),
    path: p,
    baseBranch: 'develop',
    connectionId: null,
    configFound: true,
    ...over,
  }) as Repo;

/** Only the fields the lookup reads; the rest of a task does not matter here. */
const taskAt = (worktreePath: string, extra: string): Task =>
  ({
    id: 't1',
    repoId: 'r1',
    worktreePath,
    extraWorkspaces: [{ id: 'w1', repoId: 'r2', worktreePath: extra }],
  }) as unknown as Task;

describe('loadEffectiveConfig', () => {
  it('applies the overrides of the repo at that path', async () => {
    const r = dir();
    writeFileSync(
      path.join(r, '.shellie.yml'),
      'copy: [.env]\nsetup: [npm ci]\n',
    );
    const repo = repoAt(r, { overrides: { setup: ['pnpm i'] } });
    const c = await loadEffectiveConfig(r, {
      repos: () => [repo],
      tasks: () => [],
    });
    expect(c).toMatchObject({
      copy: ['.env'],
      setup: ['pnpm i'],
      base: 'develop',
      found: true,
      fileError: null,
    });
    expect(c.sources).toMatchObject({
      setup: 'override',
      copy: 'file',
      base: 'default',
      run: 'default',
    });
    expect(c.file).toEqual({ copy: ['.env'], setup: ['npm ci'] });
  });

  it("applies the repo's overrides for a task worktree path", async () => {
    const home = dir();
    const extra = dir();
    const repo = repoAt('/repos/webshop', { overrides: { branch: 'x/{id}' } });
    const other = repoAt('/repos/api', {
      id: 'r2',
      overrides: { copy: ['.env.api'] },
    });
    const deps = {
      repos: () => [repo, other],
      tasks: () => [taskAt(home, extra)],
    };
    expect((await loadEffectiveConfig(home, deps)).branch).toBe('x/{id}');
    const e = await loadEffectiveConfig(extra, deps);
    expect(e.copy).toEqual(['.env.api']);
    expect(e.sources.copy).toBe('override');
  });

  it('unknown path: file only', async () => {
    const r = dir();
    writeFileSync(path.join(r, '.shellie.yml'), 'base: release\n');
    const c = await loadEffectiveConfig(r, {
      repos: () => [repoAt('/somewhere/else', { overrides: { base: 'x' } })],
      tasks: () => [],
    });
    expect(c.base).toBe('release');
    expect(c.sources.base).toBe('file');
    expect(c.file).toEqual({ base: 'release' });
  });

  it('broken yml throws unless lenient', async () => {
    const r = dir();
    writeFileSync(path.join(r, '.shellie.yml'), 'copy: [\n');
    const repo = repoAt(r, { overrides: { setup: ['make'] } });
    const deps = { repos: () => [repo], tasks: () => [] };
    await expect(loadEffectiveConfig(r, deps)).rejects.toBeInstanceOf(
      ShellieConfigError,
    );
    const c = await loadEffectiveConfig(r, deps, { lenient: true });
    expect(c.fileError).toMatch(/not valid YAML/);
    expect(c).toMatchObject({ setup: ['make'], copy: [], base: 'develop' });
    expect(c.file).toEqual({});
  });
});
