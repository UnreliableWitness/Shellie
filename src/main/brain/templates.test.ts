import { describe, expect, it } from 'vitest';
import { OPENCODE_TEMPLATES } from '../../shared/brain';
import {
  TEMPLATES_VERSION,
  brainOpencodePermission,
  templateFiles,
} from './templates';

const files = templateFiles('Acme');
const content = (p: string) => files.find((f) => f.path === p)?.content ?? '';
const KINDS = [
  'capture',
  'sync',
  'lint',
  'digest',
  'ask',
  'retract',
  'lessons',
  'pictures',
];

describe('templates v7', () => {
  it('is the version OpenCode needs', () => {
    expect(TEMPLATES_VERSION).toBe(7);
    expect(TEMPLATES_VERSION).toBe(OPENCODE_TEMPLATES);
  });

  it('shields sources and the dropped record, and only allows read-only git', () => {
    const p = brainOpencodePermission();
    expect(Object.keys(p.edit)).toEqual([
      '*',
      'sources/**',
      'brain/pictures-dropped.json',
    ]);
    expect(Object.values(p.edit)).toEqual(['allow', 'deny', 'deny']);
    expect(Object.keys(p.bash)).toEqual([
      '*',
      'git diff*',
      'git log*',
      'git show*',
      'git rev-parse*',
      'git status*',
    ]);
    expect(Object.values(p.bash)).toEqual([
      'deny',
      'allow',
      'allow',
      'allow',
      'allow',
      'allow',
    ]);
    expect(p.webfetch).toBe('deny');
  });

  it('writes opencode.json from that permission', () => {
    const json = JSON.parse(content('opencode.json')) as {
      $schema: string;
      permission: unknown;
    };
    expect(json.$schema).toBe('https://opencode.ai/config.json');
    expect(json.permission).toEqual(brainOpencodePermission());
    expect(files.find((f) => f.path === 'opencode.json')?.managed).toBe(true);
  });

  it('names every skill in its frontmatter (OpenCode skips a SKILL.md without a name)', () => {
    for (const kind of KINDS)
      expect(
        content(`.claude/skills/${kind}/SKILL.md`).startsWith(
          `---\nname: ${kind}\ndescription: `,
        ),
      ).toBe(true);
  });

  it('wraps every skill in an OpenCode command with its description', () => {
    for (const kind of KINDS) {
      const skill = content(`.claude/skills/${kind}/SKILL.md`);
      const description = /^description: (.*)$/m.exec(skill)![1];
      const cmd = content(`.opencode/command/${kind}.md`);
      expect(cmd.startsWith(`---\ndescription: ${description}\n---\n`)).toBe(
        true,
      );
      expect(cmd).toContain(
        `Load the \`${kind}\` skill and follow it exactly. The argument is: $ARGUMENTS`,
      );
      expect(
        files.find((f) => f.path === `.opencode/command/${kind}.md`)?.managed,
      ).toBe(true);
    }
    expect(content('.opencode/command/ask.md')).toContain(
      'Read only: never write, edit or run anything.',
    );
    expect(content('.opencode/command/capture.md')).not.toContain('Read only');
  });

  it('ignores what OpenCode creates in the folder', () => {
    const ignore = content('.gitignore');
    for (const line of [
      'brain/lock',
      '.mirror/',
      '.opencode/node_modules/',
      '.opencode/package.json',
      '.opencode/package-lock.json',
      '.opencode/bun.lock',
    ])
      expect(ignore.split('\n')).toContain(line);
  });

  it('words the skills for any agent', () => {
    for (const f of files) {
      expect(f.content).not.toContain('never reached Claude');
      expect(f.content).not.toContain('the Read tool');
    }
    const schema = content('SCHEMA.md');
    expect(schema).toContain('never reached the agent');
    expect(schema).toContain('`CLAUDE.md` or `AGENTS.md`');
    expect(content('.claude/skills/lessons/SKILL.md')).toContain(
      "a developer's conversation with their coding agent",
    );
    for (const k of ['capture', 'pictures'])
      expect(content(`.claude/skills/${k}/SKILL.md`)).toContain(
        'with your file-reading tool',
      );
  });
});
