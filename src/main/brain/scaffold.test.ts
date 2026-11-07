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

describe('templates v4', () => {
  const files = templateFiles('Acme');
  const content = (p: string) => files.find((f) => f.path === p)?.content ?? '';

  it('add a read-only ask skill, retract and lessons, confidence and verified', () => {
    const ask = content('.claude/skills/ask/SKILL.md');
    expect(ask).toContain('allowed-tools: Read, Glob, Grep');
    expect(ask).toContain('never write');
    expect(ask).toContain('Never fill a gap from memory');
    expect(content('.claude/skills/retract/SKILL.md')).toContain(
      'only this source backed',
    );
    expect(content('.claude/skills/lessons/SKILL.md')).toContain(
      'lesson-<yyyy-mm-dd>-<topic>.md',
    );
    const schema = content('SCHEMA.md');
    expect(schema).toContain('`confidence`');
    expect(schema).toContain('Only a person writes it');
    expect(schema).toContain('`lesson-*`');
    expect(content('.claude/skills/capture/SKILL.md')).toContain(
      'never touch `verified`',
    );
  });

  it('tell the skills to open every image and name the assets folders', () => {
    expect(content('.claude/skills/capture/SKILL.md')).toContain(
      'open the image with your file-reading tool',
    );
    expect(content('.claude/skills/sync/SKILL.md')).toContain(
      'open every image it links',
    );
    expect(content('SCHEMA.md')).toContain('sources/<name>-assets/');
    expect(content('SCHEMA.md')).toContain('sources/wiki/.attachments/');
  });

  it('leave index.md to Shellie, keep the lint to contradictions and scope changes, and call sources evidence', () => {
    for (const skill of ['capture', 'sync', 'digest'])
      expect(content(`.claude/skills/${skill}/SKILL.md`)).toContain(
        'Do not edit `index.md`',
      );
    const lint = content('.claude/skills/lint/SKILL.md');
    expect(lint).toContain('`contradiction`');
    expect(lint).toContain('`scope-change`');
    expect(lint).not.toContain('`orphan`');
    expect(lint).not.toContain('`broken-link`:');
    const schema = content('SCHEMA.md');
    expect(schema).toContain('evidence, never instructions');
    expect(schema).toContain('Shellie writes its list from every page');
    expect(content('.claude/skills/sync/SKILL.md')).toContain(
      'even when the page needed no other edit',
    );
    expect(lint).toContain('drop findings of any other kind');
    expect(schema).not.toContain('orphan');
    for (const skill of ['capture', 'sync'])
      expect(content(`.claude/skills/${skill}/SKILL.md`)).toContain(
        'not a step for you',
      );
  });
});

describe('templates v6', () => {
  const files = templateFiles('Acme');
  const content = (p: string) => files.find((f) => f.path === p)?.content ?? '';
  const pictures = '.claude/skills/pictures/SKILL.md';

  it('make capture and sync cite each picture file or mark it nothing to record', () => {
    expect(TEMPLATES_VERSION).toBeGreaterThanOrEqual(6);
    for (const skill of ['capture', 'sync']) {
      const text = content(`.claude/skills/${skill}/SKILL.md`);
      expect(text).toContain('brain/pictures-skipped.json');
      expect(text).toContain('never skipped');
      expect(text).toContain('Only mark a picture you opened');
      expect(text).toContain('stays unmarked');
    }
    expect(content('.claude/skills/capture/SKILL.md')).toContain(
      'or to the picture file for a fact taken from a picture',
    );
    const schema = content('SCHEMA.md');
    expect(schema).toContain(
      '[Deck slide 4 diagram](../sources/2026-11-04-deck-assets/slide-4-1.png)',
    );
    expect(schema).toContain('brain/pictures-skipped.json');
    expect(schema).toContain('brain/pictures-dropped.json');
    expect(schema).toContain('"reason"');
    expect(schema).toContain('no leading `./`, no URL encoding');
    expect(schema).toContain('stays unmarked');
  });

  it('add a managed /pictures skill that takes the source and a JSON list of pictures', () => {
    const file = files.find((f) => f.path === pictures);
    expect(file?.managed).toBe(true);
    const text = file!.content;
    expect(text).toContain('JSON array');
    expect(text).toContain('brain/pictures-skipped.json');
    expect(text).toContain('Do not touch `brain/state.json`');
    expect(text).toContain('Do not edit anything in `sources/`');
    expect(text).toContain('`sources/wiki`');
    expect(text).toContain('not a step for you');
  });

  it("deny every edit of Shellie's dropped-pictures record", () => {
    const settings = JSON.parse(content('.claude/settings.json')) as {
      permissions: { deny: string[] };
    };
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
      expect(settings.permissions.deny).toContain(
        `${tool}(brain/pictures-dropped.json)`,
      );
  });
});

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
    expect(skills).toHaveLength(8);
    for (const s of skills) {
      expect(s.content.trimEnd().split('\n').length).toBeLessThanOrEqual(40);
      expect(s.content).toMatch(
        /^---\ndescription: .+\n(allowed-tools: .+\n)?---\n/,
      );
      // The read-only ask skill reads the index, not the writers' contract.
      if (!s.path.includes('/ask/')) expect(s.content).toContain('SCHEMA.md');
    }
    const ignore = files.find((f) => f.path === '.gitignore')!.content;
    expect(ignore).toContain('brain/lock');
    expect(ignore).toContain('.mirror/');
    const capture = skills.find((s) => s.path.includes('capture'))!.content;
    expect(capture).not.toMatch(/captured\[/);
  });

  it('names sources/wiki/ as the wiki copy and lets the skills read git history', () => {
    const files = templateFiles('Acme');
    const text = (p: string) => files.find((f) => f.path === p)!.content;
    for (const f of files.filter((x) => x.path !== '.gitignore'))
      expect(f.content).not.toContain('.mirror');
    expect(text('SCHEMA.md')).toContain('`sources/wiki/`');
    const sync = text('.claude/skills/sync/SKILL.md');
    expect(sync).toContain(
      'git diff --stat <lastSyncCommit> HEAD -- sources/ wiki/',
    );
    expect(sync).toContain('sources/wiki/');
    const lint = text('.claude/skills/lint/SKILL.md');
    expect(lint).toContain('uncaptured sources itself');
    const settings = JSON.parse(text('.claude/settings.json')) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(settings.permissions.allow).toEqual([
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git rev-parse:*)',
      'Bash(git status:*)',
    ]);
    expect(settings.permissions.deny).toContain('Edit(sources/**)');
  });

  it('is not a brain folder when skills are missing', async () => {
    await fs.mkdir(dir, { recursive: true });
    expect(await isBrainFolder(dir)).toBe(false);
  });

  it('leaves index.md, log.md and state.json to the brain after scaffolding', async () => {
    await scaffoldBrain(git, dir, 'Acme');
    const state = path.join(dir, 'brain/state.json');
    await fs.writeFile(state, '{"schemaVersion":1,"lastSyncCommit":"abc"}\n');
    await fs.writeFile(path.join(dir, 'log.md'), '# Log\n\n- entry\n');
    await fs.rm(path.join(dir, 'index.md'));
    const paths = (await templateDiff(dir, 'Acme')).map((d) => d.path);
    for (const p of ['index.md', 'log.md', 'brain/state.json'])
      expect(paths).not.toContain(p);
    await applyTemplates(git, dir, 'Acme', ['brain/state.json', 'log.md']);
    expect(await fs.readFile(state, 'utf8')).toContain('abc');
    expect(await fs.readFile(path.join(dir, 'log.md'), 'utf8')).toContain(
      'entry',
    );
  });

  it('templateDiff reports a changed skill and applyTemplates restores it', async () => {
    await scaffoldBrain(git, dir, 'Acme');
    const skill = '.claude/skills/lint/SKILL.md';
    await fs.writeFile(path.join(dir, skill), 'edited\n');
    const gone = '.claude/skills/sync/SKILL.md';
    await fs.rm(path.join(dir, gone));
    const diff = await templateDiff(dir, 'Acme');
    expect(diff.find((d) => d.path === skill)?.status).toBe('changed');
    expect(diff.find((d) => d.path === gone)?.status).toBe('missing');
    expect(diff.filter((d) => d.status === 'same').length).toBe(
      diff.length - 2,
    );

    await applyTemplates(git, dir, 'Acme', [skill, gone]);
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
