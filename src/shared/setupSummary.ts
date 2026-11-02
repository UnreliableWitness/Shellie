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

/** The state Start moves a work item of this type to: the repo's override, else the type's first In Progress state when known. */
export function inProgressState(
  type: string,
  start: StartSettings,
  types: WorkItemTypeMeta[] | null,
): string {
  const states =
    types?.find((t) => t.name.toLowerCase() === type.toLowerCase())?.states ??
    [];
  const override = start.stateOverrides[type];
  if (override) return override;
  return states.find((s) => s.category === 'InProgress')?.name ?? 'In Progress';
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
  };
}
