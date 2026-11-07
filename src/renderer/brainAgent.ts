import type { AgentsDetected } from '../shared/agents';
import type { BrainAgent } from '../shared/brain';

/** The agent a new brain starts on: Claude Code if found, else OpenCode if found, else Claude Code (`found` false). */
export function defaultBrainAgent(detected: AgentsDetected | null): {
  agent: BrainAgent;
  found: boolean;
} {
  if (detected?.agents.claude.found) return { agent: 'claude', found: true };
  if (detected?.agents.opencode.found)
    return { agent: 'opencode', found: true };
  return { agent: 'claude', found: false };
}
