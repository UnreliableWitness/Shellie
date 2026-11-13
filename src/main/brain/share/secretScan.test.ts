import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../../services/GitClient';
import {
  secretsInDiff,
  treeSecretFiles,
  unquoteGitPath,
  unsentSecretFile,
} from './secretScan';

// real git, many subprocesses per test: slow under load and on the Windows runner
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const git = new GitClient();
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
let dir: string;

const commit = async (files: Record<string, string | null>, msg: string) => {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    if (text === null) await fs.rm(file);
    else {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    }
  }
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-q', '-m', msg]);
  return (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-scan-'));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'T']);
  await git.run(dir, ['config', 'user.email', 't@localhost']);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('unquoteGitPath', () => {
  it('reads a C-quoted name', () => {
    expect(unquoteGitPath('"b/a\\"b\\\\c\\tq\\303\\251.md"')).toBe(
      'b/a"b\\c\tqé.md',
    );
    expect(unquoteGitPath('b/plain.md')).toBe('b/plain.md');
  });
});

describe('secretsInDiff', () => {
  it('names the files whose added lines hold a secret, not a deleted one', () => {
    const diff = [
      'diff --git a/x.md b/x.md',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -0,0 +1 @@',
      `+token ${TOKEN}`,
      'diff --git a/y.md b/y.md',
      '--- a/y.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      `-token ${TOKEN}`,
    ].join('\n');
    expect(secretsInDiff(diff)).toEqual(['x.md']);
  });
});

describe('unsentSecretFile', () => {
  it('scans each commit on its own, a large file by itself, and passes clean ones', async () => {
    const base = await commit({ 'a.md': 'hello\n' }, 'one');
    expect(await unsentSecretFile(git, dir, base)).toBeNull();
    await commit(
      { 'big.md': `${'filler line\n'.repeat(40)}token ${TOKEN}\n` },
      'two',
    );
    const tip = await commit({ 'big.md': 'short\n' }, 'three');
    expect(await unsentSecretFile(git, dir, `${base}..${tip}`, 64)).toBe(
      'big.md',
    );
    expect(await unsentSecretFile(git, dir, `${base}..${tip}`)).toBe('big.md');
  });

  it('reads a file that shrank in a chunk of its larger side', async () => {
    const base = await commit(
      { 'shrunk.md': 'x'.repeat(500), 'n.md': 'one\n' },
      'one',
    );
    const tip = await commit(
      { 'shrunk.md': 'tiny\n', 'n.md': `token ${TOKEN}\n` },
      'two',
    );
    const seen: string[][] = [];
    class Watching extends GitClient {
      override run(
        cwd: string,
        args: string[],
        opts?: { timeoutMs?: number; env?: Record<string, string> },
      ) {
        if (args.includes('diff'))
          seen.push(args.slice(args.indexOf('--') + 1));
        return super.run(cwd, args, opts);
      }
    }
    expect(
      await unsentSecretFile(new Watching(), dir, `${base}..${tip}`, 64),
    ).toBe('n.md');
    // The shrunk file's old side is over the chunk: never in a diff with the others.
    expect(seen.flat()).not.toContain('shrunk.md');
  });

  it('skips deleted files and merges', async () => {
    const base = await commit({ 's.md': `token ${TOKEN}\n` }, 'one');
    const tip = await commit({ 's.md': null }, 'two');
    expect(await unsentSecretFile(git, dir, `${base}..${tip}`)).toBeNull();
  });
});

describe('treeSecretFiles', () => {
  it('finds secrets in small and large files of a tree', async () => {
    const c = await commit(
      {
        'small.md': `token ${TOKEN}\n`,
        'big.md': `${'filler\n'.repeat(40)}token ${TOKEN}\n`,
        'clean.md': 'nothing\n',
      },
      'one',
    );
    expect((await treeSecretFiles(git, dir, c, 64)).sort()).toEqual([
      'big.md',
      'small.md',
    ]);
  });
});
