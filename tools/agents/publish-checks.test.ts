import { describe, expect, it } from 'vitest';
import {
  branchName,
  classifyPaths,
  countChangedLines,
  prBody,
  prTitle,
  validateImplementResult,
  verifyBundle,
} from './publish-checks.mjs';

describe('branchName', () => {
  it('makes agent/issues/<n>-<slug> from the title', () => {
    expect(branchName(132, 'Opening release notes fails!')).toBe(
      'agent/issues/132-opening-release-notes-fails',
    );
  });
  it('cuts long titles at 40 characters without a trailing dash, and copes with no letters', () => {
    const b = branchName(
      7,
      'A very long title about the thing that breaks in the editor menu',
    );
    expect(b.length).toBeLessThanOrEqual('agent/issues/7-'.length + 40);
    expect(b.endsWith('-')).toBe(false);
    expect(branchName(8, '!!!')).toBe('agent/issues/8-fix');
  });
});

describe('classifyPaths', () => {
  it('finds denied and owner-only paths', () => {
    const r = classifyPaths([
      '.github/workflows/ci.yml',
      '.github/agents/trusted.yml',
      '.github/CODEOWNERS',
      '.claude/skills/sdlc-triage/SKILL.md',
      'tools/agents/x.mjs',
      'tools/release/next-version.mjs',
      'src/main/secrets/a/b.ts',
      'package.json',
      'forge.config.mts',
      'src/main/x.ts',
      '.github/ISSUE_TEMPLATE/bug.yml',
    ]);
    expect(r.denied).toEqual([
      '.github/workflows/ci.yml',
      '.github/agents/trusted.yml',
      '.github/CODEOWNERS',
      '.claude/skills/sdlc-triage/SKILL.md',
      'tools/agents/x.mjs',
      'tools/release/next-version.mjs',
    ]);
    expect(r.ownerOnly).toEqual([
      'src/main/secrets/a/b.ts',
      'package.json',
      'forge.config.mts',
    ]);
  });
});

describe('countChangedLines', () => {
  it('adds additions and deletions, skipping the lock file, CLAUDE.md and binaries', () => {
    const numstat = [
      '10\t2\tsrc/a.ts',
      '500\t300\tpackage-lock.json',
      '3\t0\tCLAUDE.md',
      '-\t-\tassets/x.png',
      '1\t1\tsrc/b.ts',
    ].join('\n');
    expect(countChangedLines(numstat)).toBe(14);
    expect(countChangedLines('')).toBe(0);
  });
});

describe('verifyBundle', () => {
  const good = {
    heads: ['refs/heads/agent/issues/1-x'],
    branch: 'agent/issues/1-x',
    isAncestor: true,
    commitCount: 2,
  };
  it('accepts one head on the base with 1-50 commits', () => {
    expect(verifyBundle(good)).toEqual({ ok: true });
  });
  it('refuses extra heads, a wrong name, a foreign base and empty or huge histories', () => {
    expect(
      verifyBundle({ ...good, heads: [...good.heads, 'refs/heads/main'] }).ok,
    ).toBe(false);
    expect(verifyBundle({ ...good, heads: ['refs/heads/main'] }).ok).toBe(
      false,
    );
    expect(verifyBundle({ ...good, isAncestor: false }).ok).toBe(false);
    expect(verifyBundle({ ...good, commitCount: 0 }).ok).toBe(false);
    expect(verifyBundle({ ...good, commitCount: 51 }).ok).toBe(false);
  });
});

describe('validateImplementResult', () => {
  it('accepts done and blocked', () => {
    expect(
      validateImplementResult({
        status: 'done',
        prTitle: 'Fix it',
        prBody: 'body',
        risk: 'low',
      }).ok,
    ).toBe(true);
    expect(
      validateImplementResult({ status: 'blocked', reason: 'needs a decision' })
        .ok,
    ).toBe(true);
  });
  it('refuses multi-line or long titles, empty bodies, bad risk and unknown statuses', () => {
    expect(
      validateImplementResult({
        status: 'done',
        prTitle: 'a\nb',
        prBody: 'x',
        risk: 'low',
      }).ok,
    ).toBe(false);
    expect(
      validateImplementResult({
        status: 'done',
        prTitle: 'a'.repeat(121),
        prBody: 'x',
        risk: 'low',
      }).ok,
    ).toBe(false);
    expect(
      validateImplementResult({
        status: 'done',
        prTitle: 'a',
        prBody: '',
        risk: 'low',
      }).ok,
    ).toBe(false);
    expect(
      validateImplementResult({
        status: 'done',
        prTitle: 'a',
        prBody: 'x',
        risk: 'none',
      }).ok,
    ).toBe(false);
    expect(validateImplementResult({ status: 'blocked' }).ok).toBe(false);
    expect(validateImplementResult(null).ok).toBe(false);
  });
});

describe('prTitle and prBody', () => {
  it('adds the issue number once', () => {
    expect(prTitle('Open release notes', 132)).toBe(
      'Open release notes (#132)',
    );
    expect(prTitle('Open release notes (#132)', 132)).toBe(
      'Open release notes (#132)',
    );
  });
  it('ends with Fixes and the Claude Code line, with the agent checks in between', () => {
    const b = prBody('What changed', 132, ['npm test failed']);
    expect(b.startsWith('What changed')).toBe(true);
    expect(b).toContain('### Agent checks\n\n- npm test failed');
    expect(b).toContain('Fixes #132');
    expect(
      b
        .trimEnd()
        .endsWith(
          '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
        ),
    ).toBe(true);
    expect(prBody('x', 1, [])).not.toContain('Agent checks');
  });

  describe('closing keywords in agent text', () => {
    it('cannot make the PR close another issue', () => {
      const b = prBody('This fixes #42 and Closes: #43; resolves #44', 132, []);
      expect(b).not.toMatch(
        /\b(fix(es|ed)?|close[sd]?|resolve[sd]?):?\s+#4[234]\b/i,
      );
      expect(b).toContain('refs #42');
      expect(b).toContain('Fixes #132');
    });
  });
});
