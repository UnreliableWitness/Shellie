import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeHasSessionsIn,
  claudeProjectFolder,
  claudeProjectsDir,
  claudeSessionExists,
  claudeSessionFile,
} from './claudeSessions';

describe('claudeSessionExists', () => {
  it('finds a session file in any project folder', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-claude-'));
    mkdirSync(path.join(dir, '-Users-d-src-webshop-worktrees-48231'));
    writeFileSync(
      path.join(dir, '-Users-d-src-webshop-worktrees-48231', 'abc.jsonl'),
      '{}\n',
    );
    expect(claudeSessionExists('abc', dir)).toBe(true);
    expect(claudeSessionExists('def', dir)).toBe(false);
    expect(claudeSessionFile('abc', dir)).toBe(
      path.join(dir, '-Users-d-src-webshop-worktrees-48231', 'abc.jsonl'),
    );
    expect(claudeSessionFile('def', dir)).toBeNull();
  });

  it('is false when Claude Code has no projects folder yet', () => {
    expect(
      claudeSessionExists('abc', path.join(os.tmpdir(), 'shellie-no-such-dir')),
    ).toBe(false);
  });

  it('honours CLAUDE_CONFIG_DIR', () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: '/cfg' })).toBe(
      path.join('/cfg', 'projects'),
    );
  });

  it('defaults to ~/.claude/projects', () => {
    expect(claudeProjectsDir({}, '/home/u')).toBe(
      path.join('/home/u', '.claude', 'projects'),
    );
  });
});

describe('claudeHasSessionsIn', () => {
  it('names the folder the way Claude Code does', () => {
    expect(claudeProjectFolder('/Users/d/src/web.worktrees/48231-x')).toBe(
      '-Users-d-src-web-worktrees-48231-x',
    );
    expect(claudeProjectFolder('C:\\Projects\\x_y')).toBe('C--Projects-x-y');
  });

  it('is true when that folder holds a session', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'shellie-claude-'));
    const cwd = '/src/web.worktrees/1-a';
    expect(claudeHasSessionsIn(cwd, dir)).toBe(false);
    mkdirSync(path.join(dir, claudeProjectFolder(cwd)));
    expect(claudeHasSessionsIn(cwd, dir)).toBe(false);
    writeFileSync(path.join(dir, claudeProjectFolder(cwd), 's.jsonl'), '{}\n');
    expect(claudeHasSessionsIn(cwd, dir)).toBe(true);
  });
});
