import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../../services/GitClient';
import { EMPTY_TREE } from '../../review/reviewGit';
import {
  mapReadCommits,
  SERVER,
  serverBase,
  unsentCount,
  withPrivateIndex,
} from './gitUtil';

// real git, many subprocesses per test: slow under load and on the Windows runner
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const git = new GitClient();
let dir: string;

const commit = async (rel: string, text: string) => {
  await fs.writeFile(path.join(dir, rel), text);
  await git.run(dir, ['add', '--', rel]);
  await git.run(dir, ['commit', '-q', '-m', rel]);
  return (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-gitutil-'));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'T']);
  await git.run(dir, ['config', 'user.email', 't@localhost']);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('unsentCount', () => {
  it('counts every commit before the server has a main, then those past it', async () => {
    await commit('a.md', 'a');
    const sent = await commit('b.md', 'b');
    expect(await serverBase(git, dir)).toBe(EMPTY_TREE);
    expect(await unsentCount(git, dir)).toBe(2);
    await git.run(dir, ['update-ref', `refs/remotes/${SERVER}`, sent]);
    expect(await serverBase(git, dir)).toBe(SERVER);
    expect(await unsentCount(git, dir)).toBe(0);
    const tip = await commit('c.md', 'c');
    await commit('d.md', 'd');
    expect(await unsentCount(git, dir)).toBe(2);
    expect(await unsentCount(git, dir, tip)).toBe(1);
  });
});

describe('withPrivateIndex', () => {
  it('builds a tree from the base plus the changes, leaving the staged work and no index file', async () => {
    const base = await commit('a.md', 'a');
    await fs.writeFile(path.join(dir, 'staged.md'), 'mine');
    await git.run(dir, ['add', '--', 'staged.md']);
    await fs.writeFile(path.join(dir, 'b.md'), 'b');
    let index = '';
    const tree = await withPrivateIndex(
      git,
      dir,
      'shellie-test-index',
      base,
      async (env, file) => {
        index = file;
        await git.run(dir, ['add', '--', 'b.md'], { env });
      },
    );
    const names = (await git.run(dir, ['ls-tree', '--name-only', tree]))
      .split('\n')
      .filter(Boolean);
    expect(names).toEqual(['a.md', 'b.md']);
    expect(
      (await git.run(dir, ['diff', '--cached', '--name-only'])).trim(),
    ).toBe('staged.md');
    await expect(fs.access(index)).rejects.toThrow();
  });
});

describe('mapReadCommits', () => {
  it('maps each read commit, keeps other keys, and says whether one changed', () => {
    const v = {
      format: 1,
      reads: { a: { commit: 'abc', x: 1 }, b: { commit: null }, c: 'odd' },
    };
    expect(mapReadCommits(v, (c) => (c === 'abc' ? 'def' : c))).toBe(true);
    expect(v.reads).toEqual({
      a: { commit: 'def', x: 1 },
      b: { commit: null },
      c: 'odd',
    });
    expect(mapReadCommits(v, (c) => c)).toBe(false);
    expect(mapReadCommits({ other: 1 }, () => null)).toBeNull();
    expect(mapReadCommits(null, () => null)).toBeNull();
  });
});
