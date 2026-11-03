import { describe, expect, it } from 'vitest';
import { BrainSchema, BrainStateSchema, brainIdOf, brainTaskId } from './brain';

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
    });
    expect(b.wiki).toBeNull();
    expect(b.terminal).toBeNull();
    expect(b.templatesVersion).toBe(0);
  });
  it('BrainStateSchema accepts an empty object', () => {
    expect(BrainStateSchema.parse({}).findings).toEqual([]);
  });
});
