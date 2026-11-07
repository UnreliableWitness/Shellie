import { describe, expect, it } from 'vitest';
import {
  BRAIN_AGENT_LABELS,
  BrainOptionsSchema,
  BrainSchema,
  BrainStateSchema,
  brainIdOf,
  brainTaskId,
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
