import { EDITOR_LABELS, type EditorPrefs } from './editors';
import type {
  SetupSummary,
  ShellieConfig,
  StartSettings,
  WorkItemRef,
  WorkItemTypeMeta,
} from './types';

/** The tabs a task opens, in the order setup opens them. */
export function setupTabLabels(
  flags: {
    startClaude: boolean;
    openShell: boolean;
    openCopilot?: boolean;
    openOpencode?: boolean;
  },
  shellLabel: string,
): string[] {
  return [
    ...(flags.startClaude ? ['Claude Code'] : []),
    ...(flags.openCopilot ? ['Copilot CLI'] : []),
    ...(flags.openOpencode ? ['OpenCode'] : []),
    ...(flags.openShell ? [shellLabel] : []),
  ];
}

/**
 * The state Start moves a work item of this type to, by Start's own rule (`planStart` in main): with the type's
 * states known (exact name), the override when it is one of its In Progress states, else its first In Progress
 * state; with them unknown, the override as given, else "In Progress".
 */
export function inProgressState(
  type: string,
  start: StartSettings,
  types: WorkItemTypeMeta[] | null,
): string {
  const override = start.stateOverrides[type];
  const states = types?.find((t) => t.name === type)?.states;
  if (!states) return override || 'In Progress';
  const inProgress = states.filter((s) => s.category === 'InProgress');
  return (
    (override && inProgress.find((s) => s.name === override)?.name) ||
    inProgress[0]?.name ||
    'In Progress'
  );
}

/** "This task will…": what a task is given, from the effective config, the New task choices and the repo's settings. */
export function buildSetupSummary(args: {
  repoId: string;
  branch: string;
  base: string;
  config: Pick<ShellieConfig, 'copy' | 'apm' | 'run'>;
  copy: boolean;
  commands: string[];
  tabs: string[];
  workItem: WorkItemRef | null;
  start: StartSettings;
  types: WorkItemTypeMeta[] | null;
  editor: EditorPrefs;
  /** The name of the project's brain whose context task.md gets; null when none (or not known yet). */
  brain: string | null;
}): SetupSummary {
  const { workItem, start } = args;
  const editorId =
    args.editor.repos[args.repoId]?.editor ?? args.editor.default ?? null;
  return {
    branch: args.branch,
    base: args.base,
    copy: args.copy ? [...args.config.copy] : [],
    commands: [...args.commands],
    apm: args.config.apm === undefined ? null : args.config.apm,
    tabs: args.tabs,
    run: Object.values(args.config.run),
    workItem: workItem
      ? {
          move: start.moveToInProgress
            ? inProgressState(workItem.type, start, args.types)
            : null,
          assign: start.assignToMe,
        }
      : null,
    editor: editorId ? EDITOR_LABELS[editorId] : null,
    brain: args.brain,
  };
}
