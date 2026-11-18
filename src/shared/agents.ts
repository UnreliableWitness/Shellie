export type AgentId = 'claude' | 'copilot' | 'opencode';

export type AgentProbe = {
  found: boolean;
  version: string | null;
  path: string | null;
};

export type AgentsDetected = {
  checkedAt: string;
  agents: Record<AgentId, AgentProbe>;
  shell: { label: string };
};

export const AGENT_IDS: AgentId[] = ['claude', 'copilot', 'opencode'];

/** Whether a terminal kind runs an agent (claude, copilot, opencode) rather than a shell or a command. */
export const isAgentKind = (kind: string): kind is AgentId =>
  (AGENT_IDS as string[]).includes(kind);

/**
 * A chosen `apm` list narrowed to the harnesses a task opens (#327): apm never installs for an agent the task
 * does not run. A task without an agent tab keeps the list as chosen.
 */
export const apmTargetsOfList = (
  listed: string[],
  tabTargets: string[],
): string[] =>
  tabTargets.length > 0 ? listed.filter((t) => tabTargets.includes(t)) : listed;

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  copilot: 'GitHub Copilot CLI',
  opencode: 'OpenCode',
};

export const INSTALL_COMMANDS: Record<AgentId, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  copilot: 'npm i -g @github/copilot',
  opencode: 'npm i -g opencode-ai',
};
