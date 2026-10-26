// bundleGit against a real git repository: the bundle format and paths git would otherwise quote.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleGit } from './implement.mjs';
import { classifyPaths, countChangedLines } from './publish-checks.mjs';

function repoWithAgentBranch() {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-qb', 'agent/issues/1-x');
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(join(dir, '.github/workflows/é.yml'), 'on: push\n');
  writeFileSync(join(dir, 'a "quoted" name.ts'), 'x\ny\n');
  git('add', '.');
  git('commit', '-qm', 'agent');
  git(
    'bundle',
    'create',
    '-q',
    'branch.bundle',
    `${base}..refs/heads/agent/issues/1-x`,
  );
  git('checkout', '-q', 'main');
  git('branch', '-qD', 'agent/issues/1-x');
  return { dir, base };
}

describe('bundleGit', () => {
  it('reads heads, ancestry, commits and unquoted paths from a real bundle', async () => {
    const { dir, base } = repoWithAgentBranch();
    const g = bundleGit(join(dir, 'branch.bundle'), 'o/r', 'token', dir);
    expect(await g.bundleHeads()).toEqual(['refs/heads/agent/issues/1-x']);
    expect(await g.isAncestor(base, 'agent/issues/1-x')).toBe(true);
    expect(await g.commitCount(base, 'agent/issues/1-x')).toBe(1);
    const files = await g.changedFiles(base, 'agent/issues/1-x');
    expect(files).toEqual(
      expect.arrayContaining(['.github/workflows/é.yml', 'a "quoted" name.ts']),
    );
    expect(classifyPaths(files).denied).toEqual(['.github/workflows/é.yml']);
    expect(countChangedLines(await g.numstat(base, 'agent/issues/1-x'))).toBe(
      3,
    );
  });
});
