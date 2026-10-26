import { describe, expect, it } from 'vitest';
import { agentEnv, claudeArgs, parseClaudeResult } from './claude.mjs';

// shape captured from Claude Code 2.1.310 (`claude -p --output-format json --json-schema ...`), trimmed
const success = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  num_turns: 2,
  result: '{"decision":"ask"}',
  structured_output: { decision: 'ask', questions: ['Which repo?'] },
  usage: { input_tokens: 2, cache_creation_input_tokens: 76373, cache_read_input_tokens: 10, output_tokens: 278 },
});

describe('agentEnv', () => {
  it('refuses to run when an API key is set (subscription only)', () => {
    expect(() => agentEnv({ ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_OAUTH_TOKEN: 't' })).toThrow(/subscription only/);
  });
  it('removes GitHub and Actions tokens and keeps the subscription token', () => {
    const env = agentEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      GH_TOKEN: 'g',
      GITHUB_TOKEN: 'g',
      GH_ENTERPRISE_TOKEN: 'g',
      AGENTS_GH_TOKEN: 'g',
      ACTIONS_RUNTIME_TOKEN: 'a',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'a',
      PATH: '/bin',
    });
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 't', PATH: '/bin' });
  });
});

describe('claudeArgs', () => {
  it('builds a print-mode call with the limits and never --bare', () => {
    const args = claudeArgs({
      model: 'claude-sonnet-5-5',
      maxTurns: 30,
      tools: ['Read', 'Grep'],
      allowedTools: ['Read', 'Grep'],
      schema: '{"type":"object"}',
      systemPromptFile: '.claude/skills/sdlc-triage/SKILL.md',
    });
    expect(args).not.toContain('--bare');
    expect(args.join(' ')).toContain('--max-turns 30');
    expect(args.join(' ')).toContain('--model claude-sonnet-5-5');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep');
  });
});

describe('parseClaudeResult', () => {
  it('reads the structured output and the tokens', () => {
    expect(parseClaudeResult(success)).toEqual({
      ok: true,
      output: { decision: 'ask', questions: ['Which repo?'] },
      tokens: 76663,
      limited: false,
    });
  });
  it('flags a usage limit by status or by text', () => {
    const r = parseClaudeResult(JSON.stringify({ is_error: true, api_error_status: 429, result: 'Too many requests' }));
    expect(r).toMatchObject({ ok: false, limited: true });
    const t = parseClaudeResult(JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached|1792998000' }));
    expect(t.limited).toBe(true);
  });
  it('is not ok for other errors, missing output or broken JSON', () => {
    expect(parseClaudeResult(JSON.stringify({ is_error: true, result: 'boom' }))).toMatchObject({ ok: false, limited: false, error: 'boom' });
    expect(parseClaudeResult(JSON.stringify({ is_error: false, result: 'text' })).ok).toBe(false);
    expect(parseClaudeResult('not json')).toMatchObject({ ok: false, limited: false });
  });
});
