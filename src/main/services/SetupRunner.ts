import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SetupEvent, SetupStepDef } from '../../shared/types';
import { pathExists } from '../fsRetry';
import { isInside } from '../paths';
import type { Command, Platform } from '../platform/Platform';
import { GitAuthError, killTree, type GitClient } from './GitClient';
import { nodeModulesMatch } from './nodeModules';
import { errorMessage } from '../../shared/errors';
import { strippableKind, stripKeys } from '../secrets/inject';
import { replaceFile } from '../secrets/replaceFile';

/** Untracked agent config copied into new worktrees by default (`copyAgentConfig: false` turns it off). */
export const AGENT_CONFIG_PATHS = [
  'opencode.json',
  'opencode.jsonc',
  '.opencode',
  '.mcp.json',
  '.claude/settings.local.json',
  '.vscode/mcp.json',
];

export type SetupPlan = {
  taskId: string;
  /** Whose stored secret names are stripped from copied env files; absent strips nothing. */
  repoId?: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  copy: string[];
  /** Also copy untracked agent config files (see AGENT_CONFIG_PATHS). */
  copyAgentConfig?: boolean;
  /** Run in the task's Setup tab once the terminals start, not by the setup itself. */
  commands: string[];
  taskMd: string;
  /** The tabs setup opens (without the Setup tab), or null for none. */
  startTerminalsLabel: string | null;
  /** Clone the repo's node_modules into the worktree when it is up to date (see nodeModules.ts). */
  cloneNodeModules?: boolean;
  /** `apm install --target` targets, when the repo has an apm.yml. */
  apmTargets?: string[];
  updateWorkItem: boolean;
  /** Reopening a finished task: the worktree is made again for its branch (see Task.reopen). */
  restore?: { from: string | null };
  /** Reopen: skip the home's worktree, copy, task-file and command steps (home dropped, or its worktree kept). */
  skipHome?: boolean;
  /** Reopen: the task's other repos whose worktrees are made again, each with its own copies and setup commands. */
  extraRestores?: ExtraRestore[];
};

export type ExtraRestore = {
  workspaceId: string;
  repoId?: string;
  repoName: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  from: string | null;
  copy: string[];
  copyAgentConfig?: boolean;
  commands: string[];
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type SetupHooks = {
  onEvent(e: SetupEvent): void;
  /** Opens the task's tabs, plus a Setup tab running `commands` when there are any. */
  startTerminals(commands: string[]): Promise<void>;
  /** The commit a freshly made worktree's branch starts from. */
  onBaseSha?(sha: string): Promise<void>;
  /** Moves the task's work item and assigns it; a thrown error becomes a warning. */
  updateWorkItem?: () => Promise<{ detail: string; warn: boolean }>;
  fromStep?: number;
};

export function planSteps(plan: SetupPlan): SetupStepDef[] {
  const steps: SetupStepDef[] = [];
  if (!plan.skipHome) {
    if (plan.restore)
      steps.push({
        kind: 'worktree',
        label: 'Restore worktree',
        detail: restoreDetail(plan.branch, plan.restore.from),
      });
    else
      steps.push(
        { kind: 'fetch', label: 'Fetch base', detail: plan.baseRef },
        {
          kind: 'worktree',
          label: 'Create branch and worktree',
          detail: plan.branch,
        },
      );
  }
  if (plan.updateWorkItem)
    steps.push({
      kind: 'work-item',
      label: 'Update work item',
      detail: 'Move to In Progress',
    });
  if (!plan.skipHome) {
    if (plan.copy.length > 0 || plan.copyAgentConfig)
      steps.push({
        kind: 'copy',
        label: 'Copy local files',
        detail: [
          ...plan.copy,
          ...(plan.copyAgentConfig ? ['agent config'] : []),
        ].join(', '),
      });
    if (plan.cloneNodeModules)
      steps.push({
        kind: 'node-modules',
        label: 'Clone node_modules',
        detail: `from ${path.basename(plan.repoPath)}`,
      });
    steps.push({
      kind: 'task-file',
      label: 'Write task file',
      detail: '.shellie/task.md',
    });
    if (plan.apmTargets && plan.apmTargets.length > 0)
      steps.push({
        kind: 'apm',
        label: 'Install agent packages',
        detail: `apm install --target ${plan.apmTargets.join(', ')}`,
      });
  }
  for (const x of plan.extraRestores ?? []) {
    const workspaceId = x.workspaceId;
    steps.push({
      kind: 'worktree',
      label: `Restore ${x.repoName} worktree`,
      detail: restoreDetail(x.branch, x.from),
      workspaceId,
    });
    if (x.copy.length > 0)
      steps.push({
        kind: 'copy',
        label: `Copy local files (${x.repoName})`,
        detail: x.copy.join(', '),
        workspaceId,
      });
    for (const command of x.commands)
      steps.push({
        kind: 'command',
        label: command,
        detail: `in ${x.repoName}`,
        command,
        workspaceId,
      });
  }
  const commands = homeCommands(plan);
  if (plan.startTerminalsLabel || commands.length > 0)
    steps.push({
      kind: 'terminals',
      label:
        plan.restore || plan.skipHome ? 'Restore terminals' : 'Start terminals',
      detail: terminalsDetail(plan.startTerminalsLabel, commands),
    });
  return steps;
}

const restoreDetail = (branch: string, from: string | null) =>
  from ? `${branch} from ${from}` : branch;

/** The home's setup commands for its Setup tab; none when the reopen keeps or drops the home. */
const homeCommands = (plan: SetupPlan): string[] =>
  plan.skipHome ? [] : plan.commands;

const NPM_CI = 'npm ci';

/** A version check that takes longer than this is treated as apm not being usable. */
const APM_VERSION_TIMEOUT_MS = 30_000;
/** How long output may still arrive after a command exits before its pipes are closed (#148). */
const EXIT_DRAIN_MS = 2_000;

function terminalsDetail(label: string | null, commands: string[]): string {
  return [label, commands.length > 0 ? `Setup (${commands.join(', ')})` : null]
    .filter(Boolean)
    .join(', ');
}

/** Adds a pattern to the repository's .git/info/exclude (shared by all worktrees) if it is not there yet. */
export async function ensureExcluded(
  git: GitClient,
  repoPath: string,
  pattern: string,
): Promise<void> {
  const common = await git.commonDir(repoPath);
  const file = path.join(common, 'info', 'exclude');
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Serialise check-then-append per file within this process; appending (never rewriting) keeps other writers' lines.
  const previous = excludeLocks.get(file) ?? Promise.resolve();
  const current = previous.then(async () => {
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (text.split('\n').some((l) => l.trim() === pattern)) return;
    const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    await fs.appendFile(file, `${sep}${pattern}\n`, 'utf8');
  });
  const tail = current.catch(() => {});
  excludeLocks.set(file, tail);
  try {
    await current;
  } finally {
    if (excludeLocks.get(file) === tail) excludeLocks.delete(file);
  }
}

const excludeLocks = new Map<string, Promise<void>>();

/** Rewrites copied env and JSON files (a file, or those in a copied folder) without the stored secret names. */
async function stripCopied(
  root: string,
  target: string,
  names: string[],
  log: (l: string) => void,
): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) {
    for (const e of await fs.readdir(target, { withFileTypes: true }))
      if (e.name !== 'node_modules' && e.name !== '.git')
        await stripCopied(root, path.join(target, e.name), names, log);
    return;
  }
  const kind = stat.isFile()
    ? strippableKind(path.relative(root, target))
    : null;
  if (!kind) return;
  const text = await fs.readFile(target, 'utf8');
  const stripped = stripKeys(text, kind, names);
  if (stripped === text) return;
  await replaceFile(target, stripped);
  log(`left stored secrets out of ${path.basename(target)}`);
}

function insideDir(base: string, rel: string): string | null {
  const target = path.resolve(base, rel);
  return isInside(base, target) ? target : null;
}

export class SetupRunner {
  constructor(
    private readonly git: GitClient,
    private readonly platform: Platform,
    /** The secret names stored for a repo (its own and All, any environment), kept out of copied env files. */
    private readonly strippedNames: (repoId: string) => string[] = () => [],
    /** `commandTimeoutMs`: a deadline for every command setup runs; none by default, since `npm ci` can run long. */
    private readonly opts: { commandTimeoutMs?: number } = {},
  ) {}

  async run(
    plan: SetupPlan,
    hooks: SetupHooks,
  ): Promise<{ ok: boolean; failedStep?: number }> {
    const steps = planSteps(plan);
    const from = hooks.fromStep ?? 0;
    if (from < 0 || from >= steps.length) {
      throw new Error(
        `Cannot retry from step ${from}: the plan has ${steps.length} steps`,
      );
    }
    const emit = (e: DistributiveOmit<SetupEvent, 'taskId'>) =>
      hooks.onEvent({ taskId: plan.taskId, ...e } as SetupEvent);
    const log = (line: string) => emit({ type: 'log', line });

    for (let index = 0; index < steps.length; index++) {
      if (index < from) {
        emit({ type: 'step', index, status: 'done' });
        continue;
      }
      emit({ type: 'step', index, status: 'running' });
      const started = Date.now();
      try {
        const out = await this.execute(steps[index], plan, hooks, log);
        emit({
          type: 'step',
          index,
          status: out && out.warn ? 'warn' : 'done',
          ...(out && out.detail ? { detail: out.detail } : {}),
          ms: Date.now() - started,
        });
      } catch (e) {
        const detail = errorMessage(e);
        log(detail);
        emit({
          type: 'step',
          index,
          status: 'failed',
          detail,
          ms: Date.now() - started,
          ...(e instanceof GitAuthError ? { auth: e.hint } : {}),
        });
        emit({ type: 'finished', ok: false, failedStep: index });
        return { ok: false, failedStep: index };
      }
    }
    emit({ type: 'finished', ok: true });
    return { ok: true };
  }

  private async execute(
    step: SetupStepDef,
    plan: SetupPlan,
    hooks: SetupHooks,
    log: (l: string) => void,
  ): Promise<{ detail?: string; warn?: boolean } | void> {
    if (step.workspaceId !== undefined) {
      const x = plan.extraRestores?.find(
        (r) => r.workspaceId === step.workspaceId,
      );
      if (!x) throw new Error(`Unknown workspace ${step.workspaceId}`);
      if (step.kind === 'worktree') return this.restoreWorktree(x, x.from, log);
      if (step.kind === 'copy')
        return this.copyFiles(x, x.copy, log, x.copyAgentConfig);
      const cmd = step.command ?? '';
      log(`$ ${cmd}`);
      return this.spawnLogged(
        this.platform.shellCommand(cmd),
        x.worktreePath,
        log,
        cmd,
      );
    }
    switch (step.kind) {
      case 'fetch': {
        log(`$ git fetch ${plan.baseRef}`);
        const fetched = await this.git.fetch(plan.repoPath, plan.baseRef);
        if (!fetched) log(`${plan.baseRef} has no remote, nothing to fetch`);
        return;
      }
      case 'worktree':
        if (plan.restore)
          return this.restoreWorktree(plan, plan.restore.from, log);
        if (await this.reusable(plan, log)) return;
        log(
          `$ git worktree add -b ${plan.branch} ${plan.worktreePath} ${plan.baseRef}`,
        );
        {
          const sha = await this.git.worktreeAdd(plan.repoPath, {
            branch: plan.branch,
            path: plan.worktreePath,
            baseRef: plan.baseRef,
          });
          await hooks.onBaseSha?.(sha);
        }
        return;
      case 'work-item': {
        if (!hooks.updateWorkItem) return { detail: 'Skipped' };
        try {
          const r = await hooks.updateWorkItem();
          log(r.detail);
          return r;
        } catch (e) {
          const detail = errorMessage(e);
          log(detail);
          return { detail, warn: true };
        }
      }
      case 'copy':
        return this.copyFiles(plan, plan.copy, log, plan.copyAgentConfig);
      case 'node-modules':
        return this.cloneNodeModules(plan, log);
      case 'task-file':
        await fs.mkdir(path.join(plan.worktreePath, '.shellie'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(plan.worktreePath, '.shellie', 'task.md'),
          plan.taskMd,
          'utf8',
        );
        await ensureExcluded(this.git, plan.repoPath, '.shellie/');
        log('wrote .shellie/task.md');
        return;
      case 'apm':
        return this.installAgentPackages(plan, log);
      case 'terminals': {
        let commands = homeCommands(plan);
        if (
          commands.some((c) => c.trim() === NPM_CI) &&
          (await nodeModulesMatch(
            path.join(plan.worktreePath, 'node_modules'),
            path.join(plan.worktreePath, 'package-lock.json'),
          ))
        ) {
          commands = commands.filter((c) => c.trim() !== NPM_CI);
          log('node_modules matches package-lock.json, npm ci skipped');
        }
        await hooks.startTerminals(commands);
        return {
          detail: terminalsDetail(plan.startTerminalsLabel, commands),
        };
      }
    }
  }

  /** A worktree left by an earlier run of this setup is used as it is. */
  private async reusable(
    w: { repoPath: string; worktreePath: string; branch: string },
    log: (l: string) => void,
  ): Promise<boolean> {
    if (
      (await pathExists(w.worktreePath)) &&
      (await this.git.branchExists(w.repoPath, w.branch))
    ) {
      log(`worktree ${w.worktreePath} already exists, reusing it`);
      return true;
    }
    return false;
  }

  /** Makes a reopened workspace's worktree again; the branch keeps its original base (no onBaseSha). */
  private async restoreWorktree(
    w: { repoPath: string; worktreePath: string; branch: string },
    from: string | null,
    log: (l: string) => void,
  ): Promise<void> {
    if (await this.reusable(w, log)) return;
    if (from === null) {
      log(`$ git worktree add ${w.worktreePath} ${w.branch}`);
      await this.git.worktreeAddExisting(w.repoPath, {
        branch: w.branch,
        path: w.worktreePath,
      });
      return;
    }
    log(`$ git worktree add -b ${w.branch} ${w.worktreePath} ${from}`);
    await this.git.worktreeAdd(w.repoPath, {
      branch: w.branch,
      path: w.worktreePath,
      baseRef: from,
    });
  }

  private async copyFiles(
    w: { repoId?: string; repoPath: string; worktreePath: string },
    copy: string[],
    log: (l: string) => void,
    agentConfig = false,
  ): Promise<void> {
    const names = w.repoId ? this.strippedNames(w.repoId) : [];
    for (const rel of copy) {
      const src = insideDir(w.repoPath, rel);
      const dest = insideDir(w.worktreePath, rel);
      if (src === null || dest === null) {
        log(`skipped ${rel} (outside the repository)`);
        continue;
      }
      if (!(await pathExists(src))) {
        log(`skipped ${rel} (not present in ${path.basename(w.repoPath)})`);
        continue;
      }
      await fs.cp(src, dest, {
        recursive: true,
      });
      log(`copied ${rel}`);
      if (names.length > 0) await stripCopied(w.worktreePath, dest, names, log);
    }
    if (agentConfig) await this.copyAgentConfigFiles(w, log);
  }

  /**
   * Copies agent config files the main checkout has but git does not track (tracked ones reach the
   * worktree through git). Symlinks are never followed, and an existing file in the worktree is kept.
   */
  private async copyAgentConfigFiles(
    w: { repoPath: string; worktreePath: string },
    log: (l: string) => void,
  ): Promise<void> {
    const tracked = new Set(
      (
        await this.git.run(w.repoPath, [
          'ls-files',
          '-z',
          '--',
          ...AGENT_CONFIG_PATHS,
        ])
      )
        .split('\0')
        .filter(Boolean),
    );
    const visit = async (rel: string): Promise<void> => {
      const src = path.join(w.repoPath, rel);
      const dest = path.join(w.worktreePath, rel);
      let st;
      try {
        st = await fs.lstat(src);
      } catch {
        return;
      }
      if (st.isSymbolicLink()) {
        log(`skipped ${rel} (symbolic link)`);
        return;
      }
      if (st.isDirectory()) {
        for (const name of await fs.readdir(src)) await visit(`${rel}/${name}`);
        return;
      }
      if (!st.isFile() || tracked.has(rel) || (await pathExists(dest))) return;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      log(`copied ${rel} (agent config)`);
    };
    for (const rel of AGENT_CONFIG_PATHS) await visit(rel);
  }

  /**
   * Clones the main checkout's node_modules when it is what `npm ci` would install for the worktree's lockfile.
   * The clone goes to a temporary folder first, so an interrupted clone never looks like an installed tree.
   */
  private async cloneNodeModules(
    plan: SetupPlan,
    log: (l: string) => void,
  ): Promise<{ detail: string; warn?: boolean }> {
    const name = path.basename(plan.repoPath);
    const src = path.join(plan.repoPath, 'node_modules');
    const dest = path.join(plan.worktreePath, 'node_modules');
    const outdated = `node_modules in ${name} is missing or out of date, npm ci installs`;
    if (await pathExists(dest)) {
      log('node_modules is already in the worktree');
      return { detail: 'Already in the worktree' };
    }
    if (
      !this.platform.cloneDir ||
      !(await nodeModulesMatch(
        src,
        path.join(plan.worktreePath, 'package-lock.json'),
      ))
    ) {
      log(outdated);
      return { detail: outdated };
    }
    const tmp = `${dest}.shellie-clone`;
    await fs.rm(tmp, { recursive: true, force: true });
    const cmd = this.platform.cloneDir(src, tmp);
    log(`cloning ${src}`);
    try {
      await this.spawnLogged(cmd, plan.worktreePath, log, 'clone');
      await fs.rename(tmp, dest);
    } catch (e) {
      await fs.rm(tmp, { recursive: true, force: true });
      const detail = `Clone failed, npm ci installs: ${errorMessage(e)}`;
      log(detail);
      return { detail, warn: true };
    }
    log(`cloned node_modules from ${name}`);
    return { detail: `Cloned from ${name}, npm ci skipped` };
  }

  /** `apm install --target <t>` per target. A missing apm is a warning; a failing install fails the step. */
  private async installAgentPackages(
    plan: SetupPlan,
    log: (l: string) => void,
  ): Promise<{ detail: string; warn?: boolean }> {
    if (!(await pathExists(path.join(plan.worktreePath, 'apm.yml')))) {
      log('no apm.yml in the worktree');
      return { detail: 'No apm.yml in the worktree' };
    }
    try {
      await this.spawnLogged(
        this.platform.shellCommand('apm --version'),
        plan.worktreePath,
        () => {},
        'apm --version',
        APM_VERSION_TIMEOUT_MS,
      );
    } catch {
      const detail = 'apm is not installed, skipped';
      log(`${detail} (see https://microsoft.github.io/apm/)`);
      return { detail, warn: true };
    }
    const targets = plan.apmTargets ?? [];
    const changedBefore = await this.changedTrackedFiles(plan.worktreePath);
    let restored: string[] = [];
    try {
      for (const target of targets) {
        const cmd = `apm install --target ${target}`;
        log(`$ ${cmd}`);
        await this.spawnLogged(
          this.platform.shellCommand(cmd),
          plan.worktreePath,
          log,
          cmd,
        );
      }
    } finally {
      restored = await this.restoreTouched(
        plan.worktreePath,
        changedBefore,
        log,
      );
    }
    return {
      detail: `Installed for ${targets.join(', ')}${restored.length > 0 ? `; kept ${restored.join(', ')} as committed` : ''}`,
    };
  }

  /** Tracked files that differ from HEAD (staged or not). */
  private async changedTrackedFiles(worktree: string): Promise<Set<string>> {
    const out = await this.git.run(worktree, [
      'diff',
      'HEAD',
      '--name-only',
      '-z',
      '--',
    ]);
    return new Set(out.split('\0').filter(Boolean));
  }

  /**
   * `apm install` rewrites committed files such as apm.lock.yaml (another apm version, or one target of
   * several), so a new task started with changes nobody made (#74). Tracked files it changed go back to
   * HEAD; the files it deployed (untracked, usually ignored) stay.
   */
  private async restoreTouched(
    worktree: string,
    before: Set<string>,
    log: (l: string) => void,
  ): Promise<string[]> {
    try {
      const touched = [...(await this.changedTrackedFiles(worktree))].filter(
        (f) => !before.has(f),
      );
      if (touched.length === 0) return [];
      await this.git.run(worktree, ['checkout', 'HEAD', '--', ...touched]);
      log(
        `kept as committed (apm install changed them): ${touched.join(', ')}`,
      );
      return touched;
    } catch (e) {
      log(`could not restore files apm install changed: ${errorMessage(e)}`);
      return [];
    }
  }

  /**
   * Runs a command, logging its output. With `timeoutMs` (or the runner's `commandTimeoutMs`) a command still
   * running then is killed with everything it started and fails with `<cmd> timed out after <s> s`.
   */
  private spawnLogged(
    { command, args, env }: Command,
    cwd: string,
    log: (l: string) => void,
    cmd: string,
    timeoutMs = this.opts.commandTimeoutMs,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let settled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let drain: NodeJS.Timeout | undefined;
      const settle = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(drain);
        if (err) reject(err);
        else resolve();
      };
      const stopReading = () => {
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const outcome = (code: number | null, signal: NodeJS.Signals | null) =>
        code === 0
          ? null
          : code === null
            ? new Error(`${cmd} was killed by signal ${signal}`)
            : new Error(`${cmd} exited with code ${code}`);
      const pipe = (stream: NodeJS.ReadableStream) => {
        let buf = '';
        stream.on('data', (chunk: Buffer | string) => {
          buf += chunk.toString();
          let nl = buf.indexOf('\n');
          while (nl >= 0) {
            log(buf.slice(0, nl).replace(/\r$/, ''));
            buf = buf.slice(nl + 1);
            nl = buf.indexOf('\n');
          }
        });
        stream.on('end', () => {
          if (buf.length > 0) log(buf);
        });
      };
      pipe(child.stdout);
      pipe(child.stderr);
      child.on('error', settle);
      child.on('close', (code, signal) => {
        if (!timedOut) settle(outcome(code, signal));
      });
      // 'close' also waits for the pipes, which a helper the command left running (on Windows) can hold open.
      child.on('exit', (code, signal) => {
        if (timedOut) return;
        drain = setTimeout(() => {
          stopReading();
          settle(outcome(code, signal));
        }, EXIT_DRAIN_MS);
      });
      if (timeoutMs !== undefined)
        timer = setTimeout(() => {
          timedOut = true;
          stopReading();
          killTree(
            child.pid,
            () => child.kill(),
            () =>
              settle(new Error(`${cmd} timed out after ${timeoutMs / 1000} s`)),
          );
        }, timeoutMs);
    });
  }
}
