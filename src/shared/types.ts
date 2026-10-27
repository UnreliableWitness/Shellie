import { TrackerProviderSchema, type TrackerProvider } from './trackers';
import { z } from 'zod';
import { TimeBookingSchema } from './time';
import type { GitAuthHint } from './gitAuth';
import { ENVIRONMENTS, type Environment } from './secrets';

export const EnvironmentSchema = z.enum(ENVIRONMENTS);

/** Work item type names come from the project's process (Agile, Scrum, Basic, custom); any string is valid. */
export type WorkItemType = string;

export const WorkItemRefSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  title: z.string().min(1),
  url: z.string().nullable().default(null),
});
export type WorkItemRef = z.infer<typeof WorkItemRefSchema>;

export const TerminalDefSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['claude', 'shell', 'run', 'copilot', 'opencode']),
  label: z.string(),
  command: z.string().optional(),
  /** Claude Code's session id (a UUID), so Restart resumes the same conversation. Absent on older tasks. */
  sessionId: z.string().optional(),
  /** The workspace (repo worktree) the tab runs in; absent means the task's active home. */
  workspaceId: z.string().optional(),
  /** The Setup tab: a `run` tab that runs these setup commands in order. Never restarted by itself. */
  setupCommands: z.array(z.string()).optional(),
});
export type TerminalDef = z.infer<typeof TerminalDefSchema>;
export type NewTerminal = Omit<TerminalDef, 'id'>;

export const TaskStatusSchema = z.enum([
  'setting-up',
  'ready',
  'setup-failed',
  'finishing',
  'done',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSetupSchema = z.object({
  copy: z.boolean(),
  commands: z.array(z.string()),
  startClaude: z.boolean(),
  openShell: z.boolean(),
  openCopilot: z.boolean().default(false),
  /** Open an OpenCode tab when the task is ready. Absent on tasks from before the choice existed. */
  openOpencode: z.boolean().optional(),
});

/** What a finished task did, captured from git just before its worktree is removed. */
export const TaskSummarySchema = z.object({
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
  commitCount: z.number().int().min(0),
  filesChanged: z.number().int().min(0),
  insertions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  pushed: z.boolean(),
  upstream: z.string().nullable(),
  /** False when the branch's starting point could not be found, so commits and changes are unknown. */
  baseKnown: z.boolean().default(true),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const StartSettingsSchema = z.object({
  moveToInProgress: z.boolean().default(true),
  assignToMe: z.boolean().default(true),
  /** Work item type -> state name. Empty means the type's first In Progress state. */
  stateOverrides: z.record(z.string(), z.string()).default({}),
});
export type StartSettings = z.infer<typeof StartSettingsSchema>;

export const PullRequestRefSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  repositoryId: z.string(),
  project: z.string(),
  repo: z.string(),
  status: z.enum(['active', 'completed', 'abandoned']),
  isDraft: z.boolean(),
});
export type PullRequestRef = z.infer<typeof PullRequestRefSchema>;

/** One more repo's worktree and branch that belongs to a task, besides its home repo. */
export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  branch: z.string().min(1),
  worktreePath: z.string().min(1),
  baseRef: z.string().min(1),
  baseSha: z.string().nullable().default(null),
  source: z.enum(['detected', 'manual']),
  summary: TaskSummarySchema.nullable().default(null),
  pullRequest: PullRequestRefSchema.nullable().default(null),
  reopen: z.object({ from: z.string().nullable() }).nullable().default(null),
  dropped: z.boolean().default(false),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/**
 * A worktree folder (and maybe its branch) Finish could not remove yet, usually because a process still holds
 * a file in it (#115). The task is done; Shellie retries in the background until it is gone.
 */
export const PendingCleanupSchema = z.object({
  workspaceId: z.string().min(1),
  repoPath: z.string().min(1),
  worktreePath: z.string().min(1),
  /** The branch to delete once the folder is gone; null keeps it. */
  branch: z.string().nullable(),
  /** When Finish first failed to remove it. */
  since: z.string(),
  attempts: z.number().int().min(0),
  /** The last failure, as git or the file system said it, and its code (EPERM, EBUSY, git, ...). */
  error: z.string(),
  code: z.string(),
  /** The one notice that it still fails after a day was shown. */
  notified: z.boolean().default(false),
});
export type PendingCleanup = z.infer<typeof PendingCleanupSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  name: z.string(),
  workItem: WorkItemRefSchema.nullable(),
  slug: z.string().min(1),
  branch: z.string().min(1),
  worktreePath: z.string().min(1),
  baseRef: z.string().min(1),
  /** The commit the branch started from, recorded when its worktree is made; null for older tasks. */
  baseSha: z.string().nullable().default(null),
  status: TaskStatusSchema,
  setup: TaskSetupSchema,
  terminals: z.array(TerminalDefSchema),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  usageSyncedAt: z.string().nullable().default(null),
  usageSyncError: z.string().nullable().default(null),
  usageCommentId: z.number().int().nullable().default(null),
  /** Null for tasks finished before Shellie recorded summaries, and while a task is open. */
  summary: TaskSummarySchema.nullable().default(null),
  pullRequest: PullRequestRefSchema.nullable().default(null),
  /** The terminal tabs when the task was finished, so Reopen can bring them (and Claude's sessions) back. */
  closedTerminals: z.array(TerminalDefSchema).default([]),
  /**
   * Set while a finished task's worktree is being made again. `from` is where the branch comes back from:
   * null when the local branch still exists, else a ref or commit to make it from.
   */
  reopen: z.object({ from: z.string().nullable() }).nullable().default(null),
  /** Worktrees in other repos that joined the task (the flat fields above are the home repo's). */
  extraWorkspaces: z.array(WorkspaceSchema).default([]),
  /** Worktree paths the user detached, so a scan does not attach them again. */
  detachedPaths: z.array(z.string()).default([]),
  /** The home workspace was dropped from the task. */
  homeDropped: z.boolean().default(false),
  /** The connection of the task's work item; null on older tasks (the home repo's connection applies). */
  connectionId: z.string().nullable().default(null),
  /** Repos whose main checkout Claude edited directly; shown as a warning, never touched. */
  mainCheckoutEdits: z
    .array(z.object({ repoPath: z.string(), branch: z.string().nullable() }))
    .default([]),
  /** When the task was open, as ISO instants; `end: null` while it is. Empty on older tasks (time falls back to createdAt/finishedAt). */
  openPeriods: z
    .array(z.object({ start: z.string(), end: z.string().nullable() }))
    .default([]),
  /** What was booked at Finish; null while open and for tasks finished before time tracking. */
  time: TimeBookingSchema.nullable().default(null),
  /** Which environment's secrets the task's tabs get; tasks from before secrets are on Development. */
  environment: EnvironmentSchema.default('development'),
  /** When a Production task falls back to Development (ISO instant); null otherwise. */
  environmentUntil: z.string().nullable().default(null),
  /** The environment the task was on when it finished (Finish then puts it back on Development); absent before. */
  finishedEnvironment: EnvironmentSchema.optional(),
  /** Worktrees a finished task still has to remove; retried in the background (#115). */
  pendingCleanup: z.array(PendingCleanupSchema).default([]),
});
export type Task = z.infer<typeof TaskSchema>;

const RepoObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  baseBranch: z.string().min(1),
  connectionId: z.string().nullable(),
  configFound: z.boolean(),
  /** Added by Shellie when a task's Claude session worked in it, not by the user; Start never picks it. */
  discovered: z.boolean().default(false),
  workItemOnStart: StartSettingsSchema.default({
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  }),
});
// Repos saved before the rename have miacYmlFound.
export const RepoSchema = z.preprocess(
  (v) =>
    v && typeof v === 'object' && 'miacYmlFound' in v && !('configFound' in v)
      ? { ...v, configFound: (v as { miacYmlFound: unknown }).miacYmlFound }
      : v,
  RepoObjectSchema,
);
export type Repo = z.infer<typeof RepoObjectSchema>;

/** What a discarded task left: the task is gone from the store, so its leftovers wait here (#124). */
export const DiscardedCleanupSchema = PendingCleanupSchema.extend({
  taskId: z.string().min(1),
});
export type DiscardedCleanup = z.infer<typeof DiscardedCleanupSchema>;

export const StateSchema = z.object({
  version: z.literal(1),
  repos: z.array(RepoSchema),
  tasks: z.array(TaskSchema),
  discardedCleanup: z.array(DiscardedCleanupSchema).default([]),
});
export type State = z.infer<typeof StateSchema>;

export type ShellieConfig = {
  base: string;
  branch: string;
  copy: string[];
  /** Copy untracked agent config (opencode.json, .mcp.json, ...) into new worktrees; `copyAgentConfig` in .shellie.yml, default true. */
  copyAgentConfig?: boolean;
  setup: string[];
  run: Record<string, string>;
  /** `apm install` targets; false turns the step off; absent means the harnesses of the task's tabs. */
  apm?: string[] | false;
  /** Extra globs collapsed under "Generated" on the Changes page (`review.collapse`). */
  reviewCollapse?: string[];
  found: boolean;
};

export type TaskView = Task & { worktreeMissing: boolean };

export type CreateTaskInput = {
  repoId: string;
  baseRef: string;
  name: string;
  workItem: WorkItemRef | null;
  branch: string;
  copy: boolean;
  commands: string[];
  startClaude: boolean;
  openShell: boolean;
  openCopilot?: boolean;
  openOpencode?: boolean;
  /** Absent: the repo's default environment (Development or Test, never UAT or Production). */
  environment?: Environment;
  /** UAT and Production need the developer's confirm; main refuses them without it. */
  environmentConfirmed?: boolean;
};

/**
 * What Finish does with one workspace: `pr` pushes and opens a draft PR, `push` only pushes, `keep` does
 * neither (it is still cleaned up per the global options), `drop` takes it out of the task without a push
 * and always removes its worktree and branch.
 */
export type WorkspaceAction = 'pr' | 'push' | 'keep' | 'drop';

export type FinishOptions = {
  closeTerminals: boolean;
  removeWorktree: boolean;
  deleteBranch: boolean;
  createPullRequest?: boolean;
  /** One entry per workspace; absent is the single-repo Finish (home: `pr` when createPullRequest, else `keep`). */
  workspaces?: {
    workspaceId: string;
    action: WorkspaceAction;
    /** Push this workspace even when its branch holds a stored secret's value, or could not be checked. */
    confirmLeak?: boolean;
  }[];
  /** The time to book on the task (seconds); absent books nothing. */
  bookedSeconds?: number;
  /** Per workspace id (`home` for a single repo): the "what changed and why" the new PR's description starts with. */
  prSummaries?: Record<string, string>;
  /** Single repo: push even when the branch holds a stored secret's value, or could not be checked (confirmed). */
  confirmLeak?: boolean;
};

export type GitFile = { status: string; path: string };
export type GitSummary = {
  branch: string;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  files: GitFile[];
};
/** What Finish did with one workspace, kept so the page can show each row's state after a failure. */
export type FinishRowResult = {
  workspaceId: string;
  action: WorkspaceAction;
  ok: boolean;
  /** The branch is on origin (pushed now or before). */
  pushed: boolean;
  /** `linked`: an existing PR, not one made by this Finish. */
  pullRequest: { id: number; url: string; linked: boolean } | null;
  error: string | null;
  /** Set when the push could not sign in to the remote. */
  auth?: GitAuthHint;
  /** Not pushed: the branch adds a stored secret's value (`found`) or could not be checked (`unchecked`). */
  leak?: 'found' | 'unchecked';
};

/** The Finish page's look at one workspace still in the task. */
export type WorkspaceCheck = {
  workspaceId: string;
  repoId: string;
  repoName: string;
  branch: string;
  /** The worktree folder is gone (removed by hand): Finish skips it. */
  missing: boolean;
  uncommitted: GitFile[];
  unpushed: number;
  /** Commits on the branch since it left its base. */
  commits: number;
  /** False when the branch's starting point could not be found: changes are unknown, so never "no changes". */
  baseKnown: boolean;
  pr: {
    available: boolean;
    reason: string | null;
    target: string | null;
    /** False when the repo is in another organization than the work item: the PR names it instead. */
    linksWorkItem: boolean;
  };
};

export type FinishChecks = {
  /** The home worktree's (as before #48). */
  uncommitted: GitFile[];
  unpushed: number;
  runningTerminals: number;
  /** Every workspace still in the task, home first. */
  workspaces: WorkspaceCheck[];
};

/** One workspace on the Discard confirm (#124). */
export type DiscardWorkspaceCheck = {
  workspaceId: string;
  repoName: string;
  worktreePath: string;
  branch: string;
  /** On another branch than the task's (joined by hand): Discard leaves it as it is, like Finish. */
  kept: boolean;
  /** The folder is gone already. */
  missing: boolean;
  /** Commits on the branch since its base. */
  commits: number;
  /** Commits on the branch that no remote has: deleting the branch loses them. */
  unpushed: number;
  /** Changed files in the folder, lost with it. */
  uncommitted: number;
};

export type DiscardChecks = {
  workspaces: DiscardWorkspaceCheck[];
  runningTerminals: number;
  /** Over the workspaces Discard removes. */
  commitsLost: number;
  uncommitted: number;
  /** Nothing done on any branch: no commits since the base and nothing uncommitted. */
  blank: boolean;
};

export type SetupStepKind =
  | 'fetch'
  | 'worktree'
  | 'copy'
  | 'task-file'
  | 'node-modules'
  | 'apm'
  /** A setup command run by the setup itself; only a reopened extra workspace's commands (the home's go to its Setup tab). */
  | 'command'
  | 'terminals'
  | 'work-item';
export type SetupStepDef = {
  kind: SetupStepKind;
  label: string;
  detail: string;
  command?: string;
  /** The extra workspace a reopen step restores; absent for the home's steps. */
  workspaceId?: string;
};
export type SetupStepStatus = 'todo' | 'running' | 'done' | 'warn' | 'failed';
export type SetupEvent =
  | {
      taskId: string;
      type: 'step';
      index: number;
      status: SetupStepStatus;
      detail?: string;
      ms?: number;
      /** A failed step whose git command could not sign in to its remote. */
      auth?: GitAuthHint;
    }
  | { taskId: string; type: 'log'; line: string }
  | { taskId: string; type: 'finished'; ok: boolean; failedStep?: number };
export type SetupState = {
  steps: {
    def: SetupStepDef;
    status: SetupStepStatus;
    detail?: string;
    ms?: number;
    auth?: GitAuthHint;
  }[];
  log: string[];
  finished: boolean;
  ok: boolean | null;
  failedStep: number | null;
};

export type Notice = {
  id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
};

export const ConnectionStatusSchema = z.enum([
  'unknown',
  'ok',
  'unauthorized',
  'unreachable',
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const ConnectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  organizationUrl: z.string().min(1),
  project: z.string().min(1),
  user: z.string().nullable(),
  status: ConnectionStatusSchema,
  checkedAt: z.string().nullable(),
  userUniqueName: z.string().nullable().default(null),
  provider: TrackerProviderSchema.default('azure-devops'),
  /** On-start options chosen when the connection was added; copied into a repo when it is linked at add. */
  workItemOnStart: StartSettingsSchema.default({
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  }),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const ConnectionsFileSchema = z.object({
  version: z.literal(1),
  connections: z.array(
    ConnectionSchema.extend({ tokenCiphertext: z.string() }),
  ),
});
export type ConnectionsFile = z.infer<typeof ConnectionsFileSchema>;

/** What the renderer sends to save a connection. The PAT travels only in this direction. */
export type ConnectionInput = {
  id?: string;
  name?: string;
  organizationUrl: string;
  project: string;
  pat: string;
  provider?: TrackerProvider;
  workItemOnStart?: StartSettings;
};

export type Iteration = { path: string; name: string };
/**
 * A sprint as the sprint page needs it; ADO leaves the dates null until someone sets them.
 * `timeframe` is set when ADO says where the sprint falls relative to today.
 */
export type SprintIteration = Iteration & {
  id: string;
  startDate: string | null;
  finishDate: string | null;
  timeframe?: 'past' | 'current' | 'future';
};

export type WorkItemSummary = {
  id: string;
  type: string;
  title: string;
  state: string;
  areaPath: string;
  iterationPath: string;
  assignedTo: string | null;
  url: string;
};

export type WorkItemSearch = { scope: 'sprint' | 'mine'; text: string };

/** A sprint backlog item: the picker's fields plus the estimate fields (hours, null when unset). */
export type SprintItem = WorkItemSummary & {
  remainingWork: number | null;
  originalEstimate: number | null;
  completedWork: number | null;
};
/** One grid row of the sprint page, in ADO's backlog order; children follow their parent. */
export type SprintRow = {
  item: SprintItem;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
};
export type Sprint = { iteration: SprintIteration | null; rows: SprintRow[] };

/** A state of a work item type, with ADO's color (`#rrggbb`) and state category (Proposed, InProgress, Completed, Removed...). */
export type WorkItemStateMeta = {
  name: string;
  color: string | null;
  category: string | null;
};
/** A work item type of the project: its color, its real ADO icon as a data URL (null when it could not be fetched) and its states. */
export type WorkItemTypeMeta = {
  name: string;
  color: string | null;
  icon: string | null;
  states: WorkItemStateMeta[];
};

/** A Markdown file in a task's worktree; `changed` is relative to the task's base. */
export type DocFile = { path: string; changed: 'new' | 'modified' | null };

/**
 * A Markdown file of the task's session: one its Claude Code sessions wrote, or one changed in a worktree.
 * `path` is relative ("/") to the workspace's worktree, or absolute ("/" separators) when `workspaceId` is null.
 */
export type SessionDoc = {
  path: string;
  workspaceId: string | null;
  changed: 'new' | 'modified' | null;
  /** Written by a Claude Code session of the task (Write, Edit, MultiEdit, NotebookEdit). */
  claude: boolean;
  mtimeMs: number;
};
