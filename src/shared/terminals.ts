import { z } from 'zod';
import { type AgentId, isAgentKind } from './agents';

/** The tabs a new task opens when nothing else is chosen (Start, and New task's pre-ticked boxes). */
export const DefaultTerminalsSchema = z.object({
  claude: z.boolean().default(true),
  copilot: z.boolean().default(false),
  opencode: z.boolean().default(false),
  shell: z.boolean().default(true),
});
export type DefaultTerminals = z.infer<typeof DefaultTerminalsSchema>;
export const defaultTerminals = (): DefaultTerminals =>
  DefaultTerminalsSchema.parse({});

/** The task setup flags for a default-terminals choice. */
export function setupTabsFrom(d: DefaultTerminals): {
  startClaude: boolean;
  openShell: boolean;
  openCopilot: boolean;
  openOpencode: boolean;
} {
  return {
    startClaude: d.claude,
    openShell: d.shell,
    openCopilot: d.copilot,
    openOpencode: d.opencode,
  };
}

/**
 * A reopened task's tabs when Reopen names an agent: the tabs it had, with that agent as its only agent. The
 * agent's own tabs stay (so its sessions resume), the other agents' tabs go, and when it had none a new tab from
 * `make` takes the place of the first agent tab (the front when there was none).
 */
export function tabsWithAgent<T extends { kind: string }>(
  defs: T[],
  agent: AgentId,
  make: () => T,
): T[] {
  if (defs.some((d) => d.kind === agent))
    return defs.filter((d) => d.kind === agent || !isAgentKind(d.kind));
  const at = defs.findIndex((d) => isAgentKind(d.kind));
  const rest = defs.filter((d) => !isAgentKind(d.kind));
  rest.splice(Math.max(at, 0), 0, make());
  return rest;
}
