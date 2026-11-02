import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempRepos, makeRepo } from '../test-helpers/gitRepo';
import { inspectCopyEntries } from './envFiles';
import { GitClient } from './GitClient';

afterAll(cleanupTempRepos);

const git = new GitClient();
const none = async () => [] as string[];

function repoWith(files: Record<string, string>, ignore: string): string {
  const repo = makeRepo();
  writeFileSync(path.join(repo, '.gitignore'), ignore);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    writeFileSync(path.join(repo, f), c);
  }
  return repo;
}

describe('inspectCopyEntries', () => {
  it('present, missing and not-ignored entries', async () => {
    const repo = repoWith({ '.env': 'A=1', 'notes.txt': 'x' }, '.env\n');
    const { entries } = await inspectCopyEntries(
      repo,
      ['.env', '.env.gone', 'notes.txt'],
      { git, secretFiles: none },
    );
    expect(entries.map((e) => [e.path, e.state])).toEqual([
      ['.env', 'present'],
      ['.env.gone', 'missing'],
      ['notes.txt', 'notIgnored'],
    ]);
    expect(entries[0]).toMatchObject({ folder: false, size: 3 });
    expect(entries[0]?.modified).toBeTruthy();
  });

  it('../x is outside', async () => {
    const repo = repoWith({}, '');
    const { entries } = await inspectCopyEntries(repo, ['../x'], {
      git,
      secretFiles: none,
    });
    expect(entries[0]).toMatchObject({ state: 'outside', folder: false });
  });

  it('a folder reports folder and file count', async () => {
    const repo = repoWith(
      { 'cfg/a.json': '{}', 'cfg/sub/b.json': '{}' },
      'cfg/\n',
    );
    const { entries } = await inspectCopyEntries(repo, ['cfg'], {
      git,
      secretFiles: none,
    });
    expect(entries[0]).toMatchObject({
      state: 'present',
      folder: true,
      files: 2,
    });
  });

  it('holdsSecrets when secretFiles lists it', async () => {
    const repo = repoWith(
      { '.env': 'A=1', 'cfg/a.json': '{}' },
      '.env\ncfg/\n',
    );
    const { entries } = await inspectCopyEntries(repo, ['.env', 'cfg'], {
      git,
      secretFiles: async () => ['.env', 'cfg/a.json'],
    });
    expect(entries.map((e) => e.state)).toEqual([
      'holdsSecrets',
      'holdsSecrets',
    ]);
  });

  it('suggestions exclude listed entries', async () => {
    const repo = repoWith({ '.env': 'A=1', '.env.local': 'B=1' }, '.env*\n');
    const { suggestions } = await inspectCopyEntries(repo, ['.env'], {
      git,
      secretFiles: none,
    });
    expect(suggestions).toEqual(['.env.local']);
  });
});
