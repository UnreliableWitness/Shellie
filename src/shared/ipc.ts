import type { ColorScheme } from './theme';
import type {
  DiscoverResult,
  Environment,
  EnvironmentInfo,
  ImportPlan,
  ImportRequest,
  ImportResult,
  LeakState,
  PendingRun,
  SecretInput,
  SecretView,
  SecretsStatus,
} from './secrets';
import type { TrackerProvider } from './trackers';
import type { TerminalFailure } from './terminalFailure';

export type RestartOptions = { withoutProjectConfig?: boolean };
import type {
  Connection,
  ConnectionInput,
  CreateTaskInput,
  DiscardChecks,
  FinishChecks,
  FinishOptions,
  FinishRowResult,
  GitSummary,
  Iteration,
  ShellieConfig,
  PullRequestRef,
  DocFile,
  SessionDoc,
  NewTerminal,
  Repo,
  SetupEvent,
  StartSettings,
  SetupState,
  Sprint,
  SprintItem,
  SprintIteration,
  Task,
  TaskView,
  TerminalDef,
  WorkItemSearch,
  WorkItemSummary,
  WorkItemTypeMeta,
  Workspace,
} from './types';
import type { AppSettings, Rate, ReceiverStatus, TaskUsage } from './usage';
import type { AgentsDetected } from './agents';
import type { RepoInspection } from './repoInspection';
import type { EditorChoice, EditorId, EditorOptions } from './editors';
import type { RendererTelemetry } from './telemetry';
import type { TitleBarKind } from './titleBar';
import type { LocalItemTime, TaskTime } from './time';
import type { AttentionSnapshot, AttentionView } from './attention';
import type { Vendor } from './budget';
import type { BudgetView } from './budgetView';
import type { CostServerStatus } from './costServer';
import type { HomePeriod, HomeSnapshot, HomeStats } from './home';
import type {
  FileContent,
  NewReviewComment,
  ReviewFileRef,
  ReviewFiles,
  ReviewScope,
  ReviewState,
  ReviewSummary,
} from './review';

/** Request/response channels. `args` is the tuple the renderer passes; `result` is what main resolves. */
export type Channels = {
  'repos:list': { args: []; result: Repo[] };
  /** What Shellie finds in a folder and the `.shellie.yml` it would write; throws when it is not a git repository. */
  'repos:inspect': { args: [folder: string]; result: RepoInspection };
  'repos:add': {
    args: [
      folder: string,
      options?: {
        writeConfig?: string;
        baseBranch?: string;
        connectionId?: string | null;
      },
    ];
    result: Repo;
  };
  'repos:remove': { args: [id: string]; result: void };
  'repos:refresh': { args: [id: string]; result: Repo };
  'repos:pickFolder': { args: []; result: string | null };
  /** The agent CLIs on this machine; cached per launch unless `force`. */
  'agents:detect': { args: [force?: boolean]; result: AgentsDetected };
  'repos:config': {
    args: [repoId: string];
    result: { config: ShellieConfig; worktreeRoot: string };
  };
  /** Masked views only; a repo id also returns the All repositories ones. */
  'secrets:list': { args: [scope: string]; result: SecretView[] };
  'secrets:save': { args: [input: SecretInput]; result: SecretView };
  'secrets:delete': { args: [id: string]; result: void };
  /** The plain value of one environment, for a held reveal; main logs the reveal (never the value). */
  'secrets:reveal': { args: [id: string, env: Environment]; result: string };
  /** Looks in the repo's known places and .NET user secrets. Masks only; main keeps the values by key for the import. */
  'secrets:discover': { args: [repoId: string]; result: DiscoverResult };
  /** Discovers again and compares with what the repo has stored: masks and keys only, the values stay in main. */
  'secrets:importPlan': { args: [repoId: string]; result: ImportPlan };
  /** Saves the picked keys' values (resolved in main), then the chosen file rewrites; forgets the held values. */
  'secrets:import': { args: [request: ImportRequest]; result: ImportResult };
  /** Forgets the values the last discovery of the repo holds in main (the import page closed). */
  'secrets:forget': { args: [repoId: string]; result: void };
  /** The repo's secrets status for the manager's panel. */
  'secrets:status': { args: [repoId: string]; result: SecretsStatus };
  /**
   * Rewrites the copied env files of the repo's open tasks (one task with `taskId`) without the stored keys and
   * starts their secret-holding tabs again; agent tabs are never touched. Returns the cleaned task ids.
   */
  'secrets:cleanWorktrees': {
    args: [repoId: string, taskId?: string];
    result: string[];
  };
  /** The environment Start uses for the repo: Development or Test, never UAT or Production. */
  'secrets:repoDefault': { args: [repoId: string]; result: Environment };
  'secrets:setRepoDefault': {
    args: [repoId: string, env: Environment];
    result: void;
  };
  'connections:list': { args: []; result: Connection[] };
  'connections:save': { args: [input: ConnectionInput]; result: Connection };
  'connections:remove': { args: [id: string]; result: void };
  'connections:verify': { args: [id: string]; result: Connection };
  /** Signs in with a new token (`pat`) or a connection's stored one (`connectionId`, its own organization) and lists the projects; saves nothing. */
  'connections:probe': {
    args: [
      input: { organizationUrl: string; pat?: string; connectionId?: string },
    ];
    result: {
      user: string;
      uniqueName: string | null;
      projects: { id: string; name: string }[];
      /** False when the token signs in but is refused the project list (no Project and Team: Read). */
      canListProjects: boolean;
    };
  };
  /** One `connections:save` per project (named `<org>/<project>`), skipping projects the organization already has a connection for. */
  'connections:saveMany': {
    args: [
      input: {
        organizationUrl: string;
        pat?: string;
        connectionId?: string;
        projects: string[];
        workItemOnStart: StartSettings;
        provider: TrackerProvider;
      },
    ];
    result: Connection[];
  };
  'repos:setConnection': {
    args: [repoId: string, connectionId: string | null];
    result: Repo;
  };
  'repos:setWorkItemOnStart': {
    args: [repoId: string, settings: StartSettings];
    result: Repo;
  };
  /** Clearing the mark makes a repo found in a task a normal repo. */
  'repos:setDiscovered': {
    args: [repoId: string, discovered: boolean];
    result: Repo;
  };
  'tasks:prAvailability': {
    args: [taskId: string, workspaceId?: string];
    result: {
      available: boolean;
      reason: string | null;
      target: string | null;
    };
  };
  'tasks:prStatus': {
    args: [taskId: string, workspaceId?: string];
    result: PullRequestRef | null;
  };
  'workItems:currentIteration': {
    args: [connectionId: string];
    result: Iteration | null;
  };
  'workItems:search': {
    args: [connectionId: string, search: WorkItemSearch];
    result: WorkItemSummary[];
  };
  /**
   * A sprint in backlog order: the chosen iteration of `team` (a name; the default team without one), else the
   * current one. `iteration: null` when the project has no current sprint or the chosen one is gone.
   */
  'workItems:sprint': {
    args: [connectionId: string, iterationId?: string, team?: string];
    result: Sprint;
  };
  /**
   * Every sprint, past, current and future, of each of my teams in the project, tagged with the team; with fewer than
   * two teams, the default team's sprints untagged.
   */
  'workItems:iterations': {
    args: [connectionId: string];
    result: SprintIteration[];
  };
  /** The project's work item types with icons as data URLs and state colors; cached in main for the session. */
  'workItems:types': {
    args: [connectionId: string];
    result: WorkItemTypeMeta[];
  };
  /** One work item, live; null when it is gone or unreadable. */
  'workItems:get': {
    args: [connectionId: string, id: string];
    result: SprintItem | null;
  };
  'shell:openExternal': { args: [url: string]; result: void };
  'docs:list': { args: [taskId: string]; result: { files: DocFile[] } };
  /** The task's session docs (every workspace, plus files outside them); the target names the task. */
  'docs:session': { args: [taskId: string]; result: { files: SessionDoc[] } };
  'docs:read': {
    args: [taskId: string, path: string];
    result: { text: string; mtimeMs: number };
  };
  'docs:asset': { args: [taskId: string, path: string]; result: string };
  'docs:resolve': {
    args: [taskId: string, path: string];
    result: {
      path: string;
      kind: 'md' | 'html' | 'file';
      workspaceId?: string;
    } | null;
  };
  /**
   * A `shellie-view:` URL for an HTML file to show in a tab: worktree-relative, or an absolute path outside the
   * worktrees (any `.html`/`.htm` file the developer clicked).
   */
  'html:open': {
    args: [taskId: string, path: string];
    result: { url: string; name: string };
  };
  /** Opens the same HTML file in the default browser. */
  'html:openExternal': { args: [taskId: string, path: string]; result: void };
  /** Installed editors; `refresh` looks again instead of using this launch's cached detection. */
  'editor:installed': { args: [refresh?: boolean]; result: EditorChoice[] };
  /** `refresh` detects the installed editors again (the menu opening). */
  'editor:options': {
    args: [taskId: string, workspaceId?: string, refresh?: boolean];
    result: EditorOptions;
  };
  'editor:openFolder': {
    args: [
      taskId: string,
      workspaceId: string | undefined,
      o: { editorId?: EditorId; solution?: string },
    ];
    result: void;
  };
  /** Opens the workspace's worktree folder in Explorer or Finder. */
  'editor:showFolder': {
    args: [taskId: string, workspaceId?: string];
    result: void;
  };
  /** Opens a worktree file (root-relative) at a line in the chosen editor, or in `editorId`. */
  'editor:openFile': {
    args: [
      taskId: string,
      workspaceId: string | undefined,
      path: string,
      line?: number,
      editorId?: EditorId,
    ];
    result: void;
  };
  'docs:openInEditor': {
    args: [taskId: string, path: string, line?: number, col?: number];
    result: void;
  };
  'docs:reveal': { args: [taskId: string, path: string]; result: void };
  'docs:watch': {
    args: [taskId: string, on: boolean];
    result: { live: boolean };
  };
  'links:open': { args: [url: string]; result: void };
  /** Everything the task changed in the scope, per repo; a repo that fails carries `error`. */
  'review:files': {
    args: [taskId: string, scope: ReviewScope];
    result: ReviewFiles;
  };
  'review:file': {
    args: [
      taskId: string,
      workspaceId: string,
      file: ReviewFileRef,
      scope: ReviewScope,
    ];
    result: FileContent;
  };
  /** Viewed files and comments, with comments located again in the current files. */
  'review:state': { args: [taskId: string]; result: ReviewState };
  'review:setViewed': {
    args: [taskId: string, key: string, hash: string | null];
    result: ReviewState;
  };
  'review:addComment': {
    args: [taskId: string, input: NewReviewComment];
    result: ReviewState;
  };
  'review:updateComment': {
    args: [
      taskId: string,
      id: string,
      patch: { text?: string; status?: 'open' | 'resolved' },
    ];
    result: ReviewState;
  };
  'review:deleteComment': {
    args: [taskId: string, id: string];
    result: ReviewState;
  };
  'review:markSent': {
    args: [taskId: string, ids: string[]];
    result: ReviewState;
  };
  'review:summary': { args: [taskId: string]; result: ReviewSummary };
  /** Discards one listed file's changes in the scope (`all` or `uncommitted`): restored to the scope's base side, or deleted when new there. */
  'review:discard': {
    args: [
      taskId: string,
      workspaceId: string,
      path: string,
      scope: ReviewScope,
    ];
    result: void;
  };
  /** Holds the file and git-dir watchers of one worktree (a docs target); `live` false means poll. */
  'review:watch': {
    args: [target: string, on: boolean];
    result: { live: boolean };
  };
  'tasks:list': { args: []; result: TaskView[] };
  'tasks:create': { args: [input: CreateTaskInput]; result: Task };
  /**
   * Switches the task's secrets to another environment and restarts the tabs that hold secrets (never agent tabs).
   * UAT and Production are refused unless `confirmed` is true; Production lasts the productionMinutes setting.
   */
  'tasks:setEnvironment': {
    args: [taskId: string, env: Environment, confirmed?: boolean];
    result: Task;
  };
  /** What the environment chip and its confirm show: value counts, the tabs a switch restarts, key names. */
  'tasks:environmentInfo': { args: [taskId: string]; result: EnvironmentInfo };
  'tasks:setupState': { args: [taskId: string]; result: SetupState | null };
  'tasks:retrySetup': { args: [taskId: string]; result: void };
  'tasks:cancelSetup': { args: [taskId: string]; result: void };
  'tasks:gitSummary': {
    args: [taskId: string, workspaceId?: string];
    result: GitSummary;
  };
  'tasks:finishChecks': { args: [taskId: string]; result: FinishChecks };
  /** Each row's outcome of the last Finish with workspaces (null before one ran); read after a failed Finish. */
  /**
   * Writes the "what changed and why" of the workspace's PR with Claude Code (#111); `text` is null, with the reason
   * in `error`, when it could not.
   */
  'tasks:prSummary': {
    args: [taskId: string, workspaceId?: string];
    result: { text: string | null; error: string | null };
  };
  'tasks:finishResults': {
    args: [taskId: string];
    result: FinishRowResult[] | null;
  };
  /** Brings a finished task back: `setup` is true when its worktree is being made again (Setup page). */
  'tasks:reopen': { args: [taskId: string]; result: { setup: boolean } };
  /** Retries a done task's leftover worktree folders now (#115); true when nothing is left. */
  'tasks:retryCleanup': { args: [taskId: string]; result: boolean };
  'tasks:finish': {
    args: [taskId: string, options: FinishOptions];
    result: void;
  };
  /** What Discard would lose (#124): per workspace its commits no remote has and its uncommitted files. */
  'tasks:discardChecks': { args: [taskId: string]; result: DiscardChecks };
  /**
   * Throws a ready task away (#124): closes its terminals, removes its worktrees and branches (a held folder is
   * retried in the background) and removes the task. Nothing is pushed, booked or written to the work item.
   */
  'tasks:discard': { args: [taskId: string]; result: void };
  'tasks:openInEditor': {
    args: [taskId: string, workspaceId?: string];
    result: void;
  };
  /** Looks for other repos' worktrees the task worked in and joins them; returns the ones added. */
  'tasks:scanWorkspaces': { args: [taskId: string]; result: Workspace[] };
  /** Joins the worktree containing a folder by hand. */
  'tasks:addWorkspace': {
    args: [taskId: string, folder: string];
    result: Workspace;
  };
  /** Drops an extra workspace from the task; its worktree and branch stay on disk. */
  'tasks:removeWorkspace': {
    args: [taskId: string, workspaceId: string];
    result: void;
  };
  'terminals:open': {
    args: [taskId: string, def: NewTerminal];
    result: TerminalDef;
  };
  'terminals:write': { args: [id: string, data: string]; result: void };
  'terminals:resize': {
    args: [id: string, cols: number, rows: number];
    result: void;
  };
  'terminals:kill': { args: [id: string]; result: void };
  /** Ends the tab's process and keeps the tab (its exit bar offers Restart or Resume session). */
  'terminals:stop': { args: [id: string]; result: void };
  /** Leak watch: the names that showed up in this agent tab and whether its input is paused; null when none. */
  'terminals:leak': { args: [id: string]; result: LeakState | null };
  /** Forwards input again to a tab paused because a Production value showed up. */
  'terminals:resume': { args: [id: string]; result: void };
  /** `shellie run` requests on UAT or Production that wait for the developer's approve. */
  'runs:pending': { args: []; result: PendingRun[] };
  /** Approves (true) or refuses a waiting `shellie run`. */
  'runs:approve': { args: [id: string, ok: boolean]; result: void };
  /** `withoutProjectConfig`: OpenCode starts without the repo's own config (#109). */
  'terminals:restart': {
    args: [id: string, options?: RestartOptions];
    result: void;
  };
  /** Why an agent tab stopped, when its exit needs explaining (#109); null otherwise. */
  'terminals:failure': { args: [id: string]; result: TerminalFailure | null };
  'terminals:buffer': { args: [id: string]; result: string };
  'terminals:isRunning': { args: [id: string]; result: boolean };
  /** The renderer re-coloured this terminal; programs that asked (mode 2031) are told the scheme changed. */
  'terminals:reportScheme': {
    args: [id: string, scheme: ColorScheme];
    result: void;
  };
  /** The last Home snapshot (from disk at launch), null before the first build. */
  'home:get': { args: []; result: HomeSnapshot | null };
  /** Rebuilds the Home snapshot over every connection, or joins the rebuild already running. */
  'home:refresh': { args: []; result: HomeSnapshot };
  /** The developer's own totals for this week or month, from local data. */
  'home:stats': { args: [period: HomePeriod]; result: HomeStats };
  /** A budget (Claude or Copilot) for a month: 0 is this one, -1 the one before. */
  'budget:get': {
    args: [vendor: Vendor, monthOffset: number];
    result: BudgetView;
  };
  /** The cost server connection, what was last sent and what waits. Never carries the key. */
  'costServer:status': { args: []; result: CostServerStatus };
  /** Checks the server with `hello` and saves the connection only when it answers; `error` says what went wrong. */
  'costServer:connect': {
    args: [c: { url: string; email: string; key: string }];
    result: CostServerStatus;
  };
  /** Forgets the server and its key and stops sending; the ledger stays. */
  'costServer:disconnect': { args: []; result: CostServerStatus };
  'usage:task': { args: [taskId: string]; result: TaskUsage };
  'usage:setBillable': {
    args: [taskId: string, sessionId: string, billable: boolean];
    result: TaskUsage;
  };
  'usage:exportCsv': { args: [taskId: string]; result: string };
  'usage:receiverStatus': { args: []; result: ReceiverStatus };
  'rates:list': { args: []; result: { rates: Rate[]; officialAsOf: string } };
  /** A downloaded update waiting for a restart; null when there is none (always in dev and on macOS). */
  'update:status': { args: []; result: PendingUpdate | null };
  /** Quits Shellie and starts the downloaded update. */
  'update:install': { args: []; result: void };
  /** True when a packaged macOS build runs outside /Applications and so cannot update itself. */
  'update:needsMove': { args: []; result: boolean };
  /** Moves Shellie to /Applications; true when the move started (Electron relaunches from there), false on refusal or error. */
  'update:moveToApplications': { args: []; result: boolean };
  /** Home's What's new card for the releases since the last dismissed one; null when none is due (always in dev). */
  'app:whatsNew': { args: []; result: WhatsNew | null };
  'app:info': {
    args: [];
    /** windowsBuild: the OS build number on Windows (for xterm's ConPTY handling), else null. */
    result: { version: string; windowsBuild: number | null };
  };
  'settings:get': { args: []; result: AppSettings };
  'settings:save': { args: [settings: AppSettings]; result: AppSettings };
  /** The task on screen, for active time (null: no task page is showing). */
  'time:focus': { args: [taskId: string | null]; result: void };
  'time:task': { args: [taskId: string]; result: TaskTime };
  /** Writes a done task's booked time to its work item again (Retry on the Done page); throws when time writing is off or the write fails. */
  'time:sync': { args: [taskId: string]; result: void };
  /** The task's time as CSV text. */
  'time:exportCsv': { args: [taskId: string]; result: string };
  /** Local time per work item id, over every task of the item on repos linked to the connection. */
  'time:sprint': {
    args: [connectionId: string];
    result: Record<string, LocalItemTime>;
  };
  /** The terminal tab on screen (null: no task page), so main does not flag what the developer is looking at. */
  'attention:view': { args: [view: AttentionView]; result: void };
  'attention:get': { args: []; result: AttentionSnapshot };
};

/** Push events from main to the renderer. */
export type Events = {
  setup: SetupEvent;
  'terminal:data': { id: string; data: string };
  'terminal:exit': { id: string; exitCode: number; failure?: TerminalFailure };
  /** Main started the terminal again by itself (a Claude Code tab resumed in the new theme): clear and size it. */
  'terminal:reset': { id: string };
  /** Leak watch in an agent tab: a new name showed up, or input was paused or resumed. Names only. */
  'terminal:leak': { id: string } & LeakState;
  /** The `shellie run` requests waiting for an approve changed (all of them, every task). */
  'runs:pending': PendingRun[];
  'tasks:changed': TaskView[];
  'repos:changed': Repo[];
  'connections:changed': Connection[];
  'secrets:changed': null;
  'usage:changed': { taskId: string };
  'time:changed': { taskId: string };
  /** Terminals that wait on the developer. */
  'attention:changed': AttentionSnapshot;
  /** A notification was clicked: show this task's terminal tab. */
  'attention:open': { taskId: string; terminalId: string };
  'usage:receiverStatus': ReceiverStatus;
  'docs:changed': { taskId: string; paths: string[] };
  /** Main stopped a task's watcher (an error, or Finish/Cancel before removing the worktree); Docs tabs poll instead. */
  'docs:watchStopped': { taskId: string };
  /** A worktree's git dir changed (commit, amend, reset, staging); `taskId` is a docs target. */
  'review:changed': { taskId: string };
  notice: { level: 'info' | 'warn' | 'error'; message: string };
  /** An update finished downloading; the renderer offers Restart and update. */
  'update:ready': PendingUpdate;
  /** A Home rebuild finished. */
  'home:updated': HomeSnapshot;
  /** The budget numbers changed (Claude or Copilot). */
  'budget:changed': Record<string, never>;
  /** The cost server connection or its sending status changed. */
  'costServer:changed': CostServerStatus;
  /** A budget notification was clicked; the renderer opens the budget view. */
  'budget:open': Record<string, never>;
  /** The main window entered or left full screen (also sent on every load). */
  'window:fullScreen': boolean;
};

/** `version` is null when the release name holds none. */
export type PendingUpdate = { version: string | null };

/** One GitHub Release on Home's What's new card: its PR titles as short notes. */
export type ReleaseNote = { version: string; url: string; items: string[] };
/**
 * What's new since the version whose card was last dismissed (`whatsNewSeen`), up to the running `version`.
 * `url` is the release page on GitHub (the long notes), or the releases list when several are covered;
 * `fetched` is false when GitHub could not be reached, and the card then shows only the link.
 */
export type WhatsNew = {
  version: string;
  url: string;
  fetched: boolean;
  releases: ReleaseNote[];
};

export type Handlers = {
  [K in keyof Channels]: (
    ...args: Channels[K]['args']
  ) => Promise<Channels[K]['result']>;
};

export type ShellieApi = {
  invoke<K extends keyof Channels>(
    channel: K,
    ...args: Channels[K]['args']
  ): Promise<Channels[K]['result']>;
  on<K extends keyof Events>(
    event: K,
    listener: (payload: Events[K]) => void,
  ): () => void;
  /** Fire-and-forget app telemetry; main validates, scrubs and drops it when the user opted out. */
  track(message: RendererTelemetry): void;
  /** How the window draws its title bar, so the header keeps room for the window controls (#49). */
  titleBar: TitleBarKind;
};

export const EVENT_PREFIX = 'shellie-event:';
