import { describe, expect, it } from 'vitest';
import {
  BRAIN_AGENT_LABELS,
  BrainOptionsSchema,
  BrainSchema,
  BrainStateSchema,
  askPrompt,
  brainIdOf,
  brainTaskId,
  isOpencodeModel,
  opencodeModelArg,
  opencodeReady,
} from './brain';

describe('brain shared types', () => {
  it('brainIdOf reads the prefix', () => {
    expect(brainIdOf('brain:abc')).toBe('abc');
    expect(brainIdOf('task-1')).toBeNull();
    expect(brainIdOf(undefined)).toBeNull();
    expect(brainIdOf(brainTaskId('x'))).toBe('x');
  });
  it('BrainSchema fills defaults', () => {
    const b = BrainSchema.parse({
      id: 'b1',
      name: 'Acme',
      connectionId: 'c1',
      project: 'Acme',
      path: '/x',
      createdAt: 't',
    });
    expect(b.options).toEqual({
      contextInTaskMd: true,
      addDirForClaude: true,
      syncAfterRefresh: false,
      weeklyDigest: false,
      dailyTokenCap: 500000,
      openBrainTerminalOnStart: false,
      model: 'sonnet',
      agent: 'claude',
      opencodeModel: null,
    });
    expect(b.wiki).toBeNull();
    expect(b.terminal).toBeNull();
    expect(b.templatesVersion).toBe(0);
  });
  it('BrainOptionsSchema defaults to Claude Code with no OpenCode model', () => {
    const o = BrainOptionsSchema.parse({});
    expect(o.agent).toBe('claude');
    expect(o.opencodeModel).toBeNull();
  });
  it('accepts only a plain provider/model as an OpenCode model', () => {
    for (const m of [
      'opencode/big-pickle',
      'anthropic/claude-sonnet-4.5',
      'ollama/llama3:8b',
    ])
      expect(isOpencodeModel(m)).toBe(true);
    for (const m of [
      'big-pickle',
      'a/b c',
      'a/b" & calc',
      'a/b|x',
      'a/b%PATH%',
      '/b',
      'a/',
      '-m/x y',
    ])
      expect(isOpencodeModel(m)).toBe(false);
    expect(opencodeModelArg('opencode/big-pickle')).toBe('opencode/big-pickle');
    expect(opencodeModelArg('a/b" & calc')).toBeNull();
    expect(opencodeModelArg(null)).toBeNull();
  });
  it('opencodeReady needs skills version 7', () => {
    expect(opencodeReady({ templatesVersion: 6 })).toBe(false);
    expect(opencodeReady({ templatesVersion: 7 })).toBe(true);
  });
  it('labels the agents', () => {
    expect(BRAIN_AGENT_LABELS).toEqual({
      claude: 'Claude Code',
      opencode: 'OpenCode',
    });
  });
  it('BrainStateSchema accepts an empty object', () => {
    expect(BrainStateSchema.parse({}).findings).toEqual([]);
  });
});

describe('askPrompt', () => {
  it('is the /ask command on Claude Code and plain text on OpenCode', () => {
    expect(askPrompt('claude', 'who owns billing?')).toBe(
      '/ask who owns billing?',
    );
    expect(askPrompt('opencode', 'who owns billing?')).toBe(
      'Load the ask skill and answer from this brain, reading only: who owns billing?',
    );
  });
});
