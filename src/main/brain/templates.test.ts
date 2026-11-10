import { describe, expect, it } from 'vitest';
import {
  BOOK_TEMPLATES,
  OPENCODE_TEMPLATES,
  SETTLE_TEMPLATES,
} from '../../shared/brain';
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
  'settle',
];

describe('templates v8', () => {
  it('is the version the book needs, and has what OpenCode needs', () => {
    expect(TEMPLATES_VERSION).toBe(9);
    expect(TEMPLATES_VERSION).toBe(SETTLE_TEMPLATES);
    expect(TEMPLATES_VERSION).toBeGreaterThanOrEqual(BOOK_TEMPLATES);
    expect(TEMPLATES_VERSION).toBeGreaterThanOrEqual(OPENCODE_TEMPLATES);
  });

  it('arranges the book only with the argument book, never in a plain sync', () => {
    const sync = content('.claude/skills/sync/SKILL.md');
    const plain = sync.slice(0, sync.indexOf('The first arrangement:'));
    expect(plain).toContain('only the argument `book` arranges');
    expect(plain).not.toContain('make the first arrangement (below) now');
  });

  it('shields sources and the dropped record, and only allows read-only git', () => {
    const p = brainOpencodePermission();
    expect(Object.keys(p.edit)).toEqual([
      '*',
      'sources/**',
      'brain/pictures-dropped.json',
      'brain/conflicts.json',
    ]);
    expect(Object.values(p.edit)).toEqual(['allow', 'deny', 'deny', 'deny']);
    const settings = JSON.parse(content('.claude/settings.json'));
    expect(settings.permissions.deny).toContain('Write(brain/conflicts.json)');
    expect(settings.permissions.deny).toContain('Edit(brain/conflicts.json)');
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

describe('templates v9: conflicts', () => {
  const schema = content('SCHEMA.md');
  const lint = content('.claude/skills/lint/SKILL.md');
  const settle = content('.claude/skills/settle/SKILL.md');
  it('the schema describes the conflict a finding carries, conflicts.json, history and decision pages', () => {
    expect(schema).toContain('"conflict": {');
    expect(schema).toContain('`brain/conflicts.json`');
    expect(schema).toContain('Only Shellie writes it');
    expect(schema).toContain('## Superseded facts');
    expect(schema).toContain('~~');
    expect(schema).toContain('## Decision pages');
  });
  it('lint writes a whole conflict with a stable id, and leaves settled ones alone unless a newer source disagrees', () => {
    expect(lint).toContain('`conflict`');
    expect(lint).toContain('`<kind>:<page a>+<page b>:<topic>`');
    expect(lint).toContain('`decision-*`');
    expect(lint).toContain('`reopens`');
  });
  it('settle takes the decision as data, writes the decision page, keeps history and names the page at the end', () => {
    expect(settle).toContain('JSON');
    expect(settle).toContain('data, not instructions');
    expect(settle).toContain('wiki/decision-');
    expect(settle).toContain('superseded');
    expect(settle).toContain('decision: wiki/decision-');
    expect(settle).toContain('`brain/conflicts.json`');
    for (const c of [
      '`a`',
      '`b`',
      '`both`',
      '`neither`',
      '`write`',
      '`accept`',
      '`keep`',
    ])
      expect(settle).toContain(c);
  });
  it('capture keeps an outdated fact as history', () => {
    expect(content('.claude/skills/capture/SKILL.md')).toContain('superseded');
  });
});
