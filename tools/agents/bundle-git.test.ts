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
  writeFileSync(join(dir, 'naïve café.ts'), 'x\ny\n');
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
      expect.arrayContaining(['.github/workflows/é.yml', 'naïve café.ts']),
    );
    expect(classifyPaths(files).denied).toEqual(['.github/workflows/é.yml']);
    expect(countChangedLines(await g.numstat(base, 'agent/issues/1-x'))).toBe(
      3,
    );
  });

  it("lists the whole PR's files against origin/main", async () => {
    const { dir, base } = repoWithAgentBranch();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', base], {
      cwd: dir,
    });
    const g = bundleGit(join(dir, 'branch.bundle'), 'o/r', 'token', dir);
    await g.bundleHeads();
    expect(await g.isAncestor(base, 'agent/issues/1-x')).toBe(true);
    expect(await g.prFiles('agent/issues/1-x')).toEqual(
      expect.arrayContaining(['.github/workflows/é.yml', 'naïve café.ts']),
    );
    expect(countChangedLines(await g.prNumstat('agent/issues/1-x'))).toBe(3);
  });

  it("counts only the fix's own commits when it merged a busy main", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-merge-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'agent/issues/2-y');
    writeFileSync(join(dir, 'b.txt'), 'pr\n');
    git('add', '.');
    git('commit', '-qm', 'pr');
    const head = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', 'main');
    for (let i = 0; i < 60; i++)
      git('commit', '-q', '--allow-empty', '-m', `main ${i}`);
    git('checkout', '-q', 'agent/issues/2-y');
    git('merge', '-q', '--no-edit', 'main');
    git(
      'bundle',
      'create',
      '-q',
      'branch.bundle',
      `${head}..refs/heads/agent/issues/2-y`,
    );
    const g = bundleGit(join(dir, 'branch.bundle'), 'o/r', 'token', dir);
    expect(await g.isAncestor(head, 'agent/issues/2-y')).toBe(true);
    expect(await g.commitCount(head, 'agent/issues/2-y')).toBe(1);
  });
});
