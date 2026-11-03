import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitClient } from '../services/GitClient';
import {
  appendContext,
  appendLog,
  CONTEXT_MAX_LINES,
  closeLine,
  contextSection,
} from './context';
import { scaffoldBrain } from './scaffold';

describe('brain context', () => {
  it('contextSection caps index.md at 150 lines', () => {
    const s = contextSection(
      'Acme',
      '/b',
      Array.from({ length: 160 }, (_, i) => `- p${i}`).join('\n'),
    );
    expect(CONTEXT_MAX_LINES).toBe(150);
    expect(
      s.startsWith(
        "## Context: Acme\nThe project's brain is at /b. Read-only for this task: read pages, do not edit them.\n",
      ),
    ).toBe(true);
    expect(s).toContain('- p149');
    expect(s).not.toContain('- p150');
    expect(s.trim().endsWith('… 10 more in index.md')).toBe(true);
  });

  it('contextSection keeps a short index whole, without a cut marker', () => {
    const s = contextSection(
      'Acme',
      '/b',
      '# Index\n\n- [Scope](wiki/scope.md)\n',
    );
    expect(s).toContain('- [Scope](wiki/scope.md)');
    expect(s).not.toContain('more in index.md');
  });

  it('closeLine formats the spec line', () => {
    expect(
      closeLine(new Date('2026-11-03T10:00:00Z'), '156', 'Title', 'https://pr'),
    ).toBe('- 2026-11-03T10:00:00.000Z task #156 closed: Title (https://pr)');
  });

  it('closeLine without a work item has no number', () => {
    expect(
      closeLine(new Date('2026-11-03T10:00:00Z'), null, 'Tidy', 'feature/x'),
    ).toBe('- 2026-11-03T10:00:00.000Z task closed: Tidy (feature/x)');
  });

  describe('files', () => {
    let root: string;
    const git = new GitClient();
    beforeEach(async () => {
      root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-ctx-')),
      );
    });
    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('appendContext appends the section after a blank line', async () => {
      const file = path.join(root, 'task.md');
      await fs.writeFile(file, '# Task\n');
      await appendContext(file, '## Context: Acme\nbody\n');
      expect(await fs.readFile(file, 'utf8')).toBe(
        '# Task\n\n## Context: Acme\nbody\n',
      );
    });

    it('appends two close lines in a row, newest first, one commit each', async () => {
      const dir = path.join(root, 'brain');
      await scaffoldBrain(git, dir, 'Acme');
      const before = Number(
        (await git.run(dir, ['rev-list', '--count', 'HEAD'])).trim(),
      );
      await appendLog(git, dir, '- first');
      await appendLog(git, dir, '- second');
      const log = await fs.readFile(path.join(dir, 'log.md'), 'utf8');
      expect(log).toBe('# Log\n\n- second\n- first\n');
      const after = Number(
        (await git.run(dir, ['rev-list', '--count', 'HEAD'])).trim(),
      );
      expect(after - before).toBe(2);
      expect((await git.run(dir, ['log', '-1', '--format=%s'])).trim()).toBe(
        'Brain: task closed',
      );
      expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
    });
  });
});
