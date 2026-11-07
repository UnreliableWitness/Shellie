import { describe, expect, it } from 'vitest';
import type { AgentsDetected } from '../shared/agents';
import { defaultBrainAgent } from './brainAgent';

const detected = (claude: boolean, opencode: boolean): AgentsDetected => {
  const probe = (found: boolean) => ({ found, version: null, path: null });
  return {
    checkedAt: '2026-11-07T10:00:00.000Z',
    agents: {
      claude: probe(claude),
      copilot: probe(false),
      opencode: probe(opencode),
    },
    shell: { label: 'zsh' },
  };
};

describe('defaultBrainAgent', () => {
  it('prefers Claude Code when it is found, even with OpenCode', () => {
    expect(defaultBrainAgent(detected(true, true))).toEqual({
      agent: 'claude',
      found: true,
    });
  });
  it('takes OpenCode when only it is found', () => {
    expect(defaultBrainAgent(detected(false, true))).toEqual({
      agent: 'opencode',
      found: true,
    });
  });
  it('falls back to Claude Code, not found, when neither is', () => {
    expect(defaultBrainAgent(detected(false, false))).toEqual({
      agent: 'claude',
      found: false,
    });
  });
  it('counts a detection that has not arrived as nothing found', () => {
    expect(defaultBrainAgent(null)).toEqual({ agent: 'claude', found: false });
  });
});
