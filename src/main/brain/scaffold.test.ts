import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitClient } from '../services/GitClient';
import {
  applyTemplates,
  isBrainFolder,
  scaffoldBrain,
  templateDiff,
} from './scaffold';
import { TEMPLATES_VERSION, templateFiles } from './templates';

describe('brain scaffold', () => {
  let root: string;
  let dir: string;
  const git = new GitClient();

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-brain-')),
    );
    dir = path.join(root, 'acme', 'brain');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('scaffolds a brain with templates and a first commit', async () => {
    await scaffoldBrain(git, dir, 'Acme');
    expect(await isBrainFolder(dir)).toBe(true);
    expect(await fs.readFile(path.join(dir, 'index.md'), 'utf8')).toContain(
      '# Acme brain',
    );
    expect(
      (await git.run(dir, ['log', '--oneline'])).trim().split('\n'),
    ).toHaveLength(1);
    expect(
      await fs.readFile(path.join(dir, '.claude/settings.json'), 'utf8'),
    ).toContain('Edit(sources/**)');
    await fs.stat(path.join(dir, 'sources/.gitkeep'));
    await fs.stat(path.join(dir, 'wiki/.gitkeep'));
    expect((await git.run(dir, ['status', '--porcelain'])).trim()).toBe('');
    expect(await git.run(dir, ['branch', '--show-current'])).toBe('main\n');
  });

  it('never writes a CLAUDE.md', async () => {
    await scaffoldBrain(git, dir, 'Acme');
    await expect(fs.stat(path.join(dir, 'CLAUDE.md'))).rejects.toThrow();
    expect(templateFiles('Acme').map((f) => f.path)).not.toContain('CLAUDE.md');
  });

  it('keeps each skill short, describes when to use it and ignores lock and mirror', () => {
    const files = templateFiles('Acme');
    const skills = files.filter((f) => f.path.endsWith('SKILL.md'));
    expect(skills).toHaveLength(4);
    for (const s of skills) {
      expect(s.content.trimEnd().split('\n').length).toBeLessThanOrEqual(40);
      expect(s.content).toMatch(/^---\ndescription: .+\n---\n/);
      expect(s.content).toContain('SCHEMA.md');
    }
    const ignore = files.find((f) => f.path === '.gitignore')!.content;
    expect(ignore).toContain('brain/lock');
    expect(ignore).toContain('.mirror/');
    const capture = skills.find((s) => s.path.includes('capture'))!.content;
    expect(capture).not.toMatch(/captured\[/);
  });

  it('is not a brain folder when skills are missing', async () => {
    await fs.mkdir(dir, { recursive: true });
    expect(await isBrainFolder(dir)).toBe(false);
  });

  it('templateDiff reports a changed skill and applyTemplates restores it', async () => {
    await scaffoldBrain(git, dir, 'Acme');
    const skill = '.claude/skills/lint/SKILL.md';
    await fs.writeFile(path.join(dir, skill), 'edited\n');
    await fs.rm(path.join(dir, 'log.md'));
    const diff = await templateDiff(dir, 'Acme');
    expect(diff.find((d) => d.path === skill)?.status).toBe('changed');
    expect(diff.find((d) => d.path === 'log.md')?.status).toBe('missing');
    expect(diff.filter((d) => d.status === 'same').length).toBe(
      diff.length - 2,
    );

    await applyTemplates(git, dir, 'Acme', [skill, 'log.md']);
    expect(
      (await templateDiff(dir, 'Acme')).every((d) => d.status === 'same'),
    ).toBe(true);
    const log = (await git.run(dir, ['log', '--format=%s'])).trim().split('\n');
    expect(log).toEqual([
      `Brain: update skills to v${TEMPLATES_VERSION}`,
      'Brain created',
    ]);
  });
});
