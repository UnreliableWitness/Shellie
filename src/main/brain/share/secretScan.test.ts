import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../../services/GitClient';
import { treeSecretFiles, unsentSecretFile } from './secretScan';

// real git, many subprocesses per test: slow under load and on the Windows runner
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const git = new GitClient();
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
/** More than GitClient's 16 MB output buffer. */
const OVER_BUFFER = `${'filler line\n'.repeat(1_500_000)}token ${TOKEN}\n`;
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
  await git.run(dir, ['commit', '-q', '--allow-empty', '-m', msg]);
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

describe('unsentSecretFile', () => {
  it('scans each commit on its own and passes clean ones', async () => {
    const base = await commit({ 'a.md': 'hello\n' }, 'one');
    expect(await unsentSecretFile(dir, base)).toBeNull();
    await commit(
      { 'big.md': `${'filler line\n'.repeat(40)}token ${TOKEN}\n` },
      'two',
    );
    // A later commit taking the line out does not clear the earlier one.
    const tip = await commit({ 'big.md': 'short\n' }, 'three');
    expect(await unsentSecretFile(dir, `${base}..${tip}`)).toBe('big.md');
  });

  it('finds a secret in a diff larger than a git output buffer', async () => {
    const base = await commit({ 'a.md': 'hello\n' }, 'one');
    const tip = await commit({ 'huge.md': OVER_BUFFER }, 'two');
    expect(await unsentSecretFile(dir, `${base}..${tip}`)).toBe('huge.md');
  });

  it('skips the commits found clean before and remembers new clean ones', async () => {
    const base = await commit({ 'a.md': 'hello\n' }, 'one');
    const clean = await commit({ 'b.md': 'fine\n' }, 'two');
    const empty = await commit({}, 'empty');
    const clean2 = await commit({ 'c.md': 'also fine\n' }, 'three');
    const seen = new Set<string>();
    expect(await unsentSecretFile(dir, `${base}..${clean2}`, seen)).toBeNull();
    expect([...seen].sort()).toEqual([clean, empty, clean2].sort());
    const leak = await commit({ 'd.md': `token ${TOKEN}\n` }, 'four');
    const after = await commit({ 'e.md': 'later\n' }, 'five');
    // A commit in the set is never read again: one marked clean by hand is passed.
    expect(await unsentSecretFile(dir, `${base}..${after}`, seen)).toBe('d.md');
    expect(seen.has(leak)).toBe(false);
    expect(seen.has(after)).toBe(false);
    seen.add(leak);
    expect(await unsentSecretFile(dir, `${base}..${after}`, seen)).toBeNull();
    expect(seen.has(after)).toBe(true);
  });

  it('names a file with a space as it is', async () => {
    const base = await commit({ 'a.md': 'hello\n' }, 'one');
    const tip = await commit({ 'sources/a b.md': `token ${TOKEN}\n` }, 'two');
    expect(await unsentSecretFile(dir, `${base}..${tip}`)).toBe(
      'sources/a b.md',
    );
  });

  // Windows file names cannot hold a quote.
  it.skipIf(process.platform === 'win32')(
    'names a file git quotes as it is',
    async () => {
      const base = await commit({ 'a.md': 'hello\n' }, 'one');
      const tip = await commit({ 'sources/a"b.md': `token ${TOKEN}\n` }, 'two');
      expect(await unsentSecretFile(dir, `${base}..${tip}`)).toBe(
        'sources/a"b.md',
      );
    },
  );

  it('rejects when git fails or cannot start, so the push is held', async () => {
    const base = await commit({ 'a.md': 'hello\n' }, 'one');
    const tip = await commit({ 'n.md': 'note\n' }, 'two');
    await expect(
      unsentSecretFile(dir, `${base}..${tip}`, undefined, {
        git: path.join(dir, 'no-such-git'),
      }),
    ).rejects.toThrow(/could not start/);
    await expect(unsentSecretFile(dir, 'no-such-ref')).rejects.toThrow(
      /failed/,
    );
  });

  it('skips deleted files and merges', async () => {
    const base = await commit({ 's.md': `token ${TOKEN}\n` }, 'one');
    const tip = await commit({ 's.md': null }, 'two');
    expect(await unsentSecretFile(dir, `${base}..${tip}`)).toBeNull();
  });
});

describe('treeSecretFiles', () => {
  it('lists every file of a tree with a secret, also a quoted and a huge one', async () => {
    // Windows file names cannot hold a quote.
    const quoted = process.platform === 'win32' ? 'sub/q t.md' : 'sub/q"t.md';
    const c = await commit(
      {
        'small.md': `token ${TOKEN}\n`,
        [quoted]: `token ${TOKEN}\n`,
        'huge.md': OVER_BUFFER,
        'clean.md': 'nothing\n',
      },
      'one',
    );
    expect((await treeSecretFiles(dir, c)).sort()).toEqual(
      ['huge.md', 'small.md', quoted].sort(),
    );
  });
});
