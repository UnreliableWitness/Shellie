/** Where a command shows in the palette. */
export type CommandGroup = "task" | "goto" | "tasks" | "app";

export const GROUP_TITLE: Record<CommandGroup, string> = {
  task: "This task",
  goto: "Go to",
  tasks: "Tasks",
  app: "App",
};

export const GROUP_ORDER: CommandGroup[] = ["task", "goto", "tasks", "app"];

/**
 * A key with the platform's mod key (Cmd on macOS, Ctrl elsewhere); Alt is never part of one.
 * `code` is `KeyboardEvent.code`, so a digit is the physical key (AZERTY's top row types & é " and so on);
 * `Digit3` also takes `Numpad3`.
 */
export type Shortcut = { code: string; shift?: boolean };

/**
 * One thing the app can do or one place it can go: a row in the palette, and its shortcut when it has one.
 * The id is sent with telemetry, so it is a fixed string or ends in an index: never a task, project, repo, brain
 * or file name.
 */
export type Command = {
  id: string;
  title: string;
  group: CommandGroup;
  shortcut?: Shortcut;
  /** A quiet word at the right of the row, such as "3 files". */
  note?: string;
  /** `accent` for a note that says something waits for the user. */
  noteTone?: "accent";
  run(): void;
};
