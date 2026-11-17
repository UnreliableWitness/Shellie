import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { convertAgentFile, normalizeOpenCodeAgents } from './opencodeAgents';

const BODY =
  '\nYou explore the wiki.\n\n# Sources\n\n- `../DXP.Wiki`: the mirror\n';
const CLAUDE_AGENT = [
  '---',
  'name: dxp-wiki-explorer',
  'description: Use this agent to discover wiki content (`../DXP.Wiki`).',
  'tools: Read, Glob, Grep, mcp__azure-devops__wiki_get_wiki, Bash',
  'model: haiku',
  '---',
  BODY,
].join('\n');

const frontmatter = (text: string) =>
  parseYaml(text.split('---')[1]) as Record<string, unknown>;

describe('convertAgentFile', () => {
  it("turns Claude Code's tools list into OpenCode's map and drops a bare model (#318)", () => {
    const out = convertAgentFile(CLAUDE_AGENT);
    expect(out).toBeDefined();
    const fm = frontmatter(out!);
    expect(fm.tools).toEqual({
      read: true,
      glob: true,
      grep: true,
      'azure-devops_wiki_get_wiki': true,
      bash: true,
    });
    expect(fm).not.toHaveProperty('model');
    expect(fm.name).toBe('dxp-wiki-explorer');
    expect(out).not.toMatch(/^model:/m);
    expect(out!.endsWith(`---\n${BODY}`)).toBe(true);
  });

  it('converts a list, keeps a provider/model id, and logs unknown tools', () => {
    const logs: string[] = [];
    const out = convertAgentFile(
      [
        '---',
        'tools:',
        '  - Bash(git:*)',
        '  - WebFetch',
        '  - FancyTool',
        'model: anthropic/claude-haiku-4-5',
        '---',
        'body',
      ].join('\n'),
      (l) => logs.push(l),
    );
    const fm = frontmatter(out!);
    expect(fm.tools).toEqual({ bash: true, webfetch: true, fancytool: true });
    expect(fm.model).toBe('anthropic/claude-haiku-4-5');
    expect(logs).toEqual(['kept unknown tool FancyTool as fancytool']);
  });

  it('keeps CRLF line endings', () => {
    const out = convertAgentFile(CLAUDE_AGENT.replace(/\n/g, '\r\n'));
    expect(out).toContain('tools:\r\n  read: true\r\n');
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it('leaves a file that already has a map, has no frontmatter, or cannot be parsed', () => {
    expect(
      convertAgentFile('---\nname: x\ntools:\n  read: true\n---\nbody\n'),
    ).toBeUndefined();
    expect(convertAgentFile('# Just text\ntools: Read\n')).toBeUndefined();
    expect(convertAgentFile('---\ntools: [Read\n---\nbody\n')).toBeUndefined();
    expect(convertAgentFile('---\nname: x\n---\nbody\n')).toBeUndefined();
  });
});

describe('normalizeOpenCodeAgents', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rewrites only the agent files that need it', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'oc-agents-'));
    const agents = path.join(dir, '.opencode', 'agents');
    mkdirSync(agents, { recursive: true });
    const mapped = '---\ntools:\n  read: true\n---\nbody\n';
    const plain = '# Notes\n\nNo frontmatter here.\n';
    writeFileSync(path.join(agents, 'x.md'), CLAUDE_AGENT);
    writeFileSync(path.join(agents, 'mapped.md'), mapped);
    writeFileSync(path.join(agents, 'plain.md'), plain);
    const logs: string[] = [];

    const converted = await normalizeOpenCodeAgents(dir, (l) => logs.push(l));

    expect(converted).toEqual(['.opencode/agents/x.md']);
    expect(logs).toEqual([
      "converted .opencode/agents/x.md to OpenCode's agent format",
    ]);
    expect(
      frontmatter(readFileSync(path.join(agents, 'x.md'), 'utf8')).tools,
    ).toMatchObject({ read: true });
    expect(readFileSync(path.join(agents, 'mapped.md'), 'utf8')).toBe(mapped);
    expect(readFileSync(path.join(agents, 'plain.md'), 'utf8')).toBe(plain);
  });

  it('does nothing when there is no .opencode folder', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'oc-agents-'));
    expect(await normalizeOpenCodeAgents(dir, () => {})).toEqual([]);
  });
});
