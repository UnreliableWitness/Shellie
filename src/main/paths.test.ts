import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { folderPaths, userDataOverride, worktreeRoot } from './paths';

describe('worktreeRoot', () => {
  it('is a sibling folder named <repo>.worktrees', () => {
    // path.resolve adds the drive letter on Windows.
    const expected = `${path.resolve('/src/webshop')}.worktrees`;
    expect(worktreeRoot('/src/webshop')).toBe(expected);
    expect(worktreeRoot('/src/webshop/')).toBe(expected);
  });
});

describe('userDataOverride', () => {
  it('returns an absolute SHELLIE_USER_DATA', () => {
    const dir = path.resolve('/tmp/shellie-profile');
    expect(userDataOverride({ SHELLIE_USER_DATA: dir }, false)).toBe(dir);
  });

  it('is null when unset, blank or relative', () => {
    expect(userDataOverride({}, false)).toBeNull();
    expect(userDataOverride({ SHELLIE_USER_DATA: '  ' }, false)).toBeNull();
    expect(
      userDataOverride({ SHELLIE_USER_DATA: 'profile' }, false),
    ).toBeNull();
  });

  it('is ignored in a packaged build', () => {
    const dir = path.resolve('/tmp/shellie-profile');
    expect(userDataOverride({ SHELLIE_USER_DATA: dir }, true)).toBeNull();
  });
});

describe('folderPaths', () => {
  it('gives the folder and its real path, or the folder alone', () => {
    const real = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'paths-')));
    expect(folderPaths(real)).toEqual([real]);
    const link = path.join(real, 'link');
    symlinkSync(real, link);
    expect(folderPaths(link)).toEqual([link, real]);
    expect(folderPaths('/nope/brain')).toEqual(['/nope/brain']);
  });
});
