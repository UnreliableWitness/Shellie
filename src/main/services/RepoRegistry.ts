import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  AgentCommandsSchema,
  StartSettingsSchema,
  type AgentCommands,
  type Repo,
  type StartSettings,
} from '../../shared/types';
import type { GitClient } from './GitClient';
import { samePath } from '../paths';
import { loadShellieConfig } from './ShellieConfig';
import type { TaskStore } from './TaskStore';

export type AddRepoOptions = {
  /** The `.shellie.yml` text to write into the repo before registering it. */
  writeConfig?: string;
  baseBranch?: string;
  connectionId?: string | null;
  /** The linked connection's on-start options; the repo default without one. */
  workItemOnStart?: StartSettings;
};

export class RepoRegistry {
  constructor(
    private readonly store: TaskStore,
    private readonly git: GitClient,
    private readonly loadConfig: typeof loadShellieConfig = loadShellieConfig,
  ) {}

  list(): Repo[] {
    return this.store.state.repos;
  }

  get(id: string): Repo {
    const repo = this.store.state.repos.find((r) => r.id === id);
    if (!repo) throw new Error(`Unknown repo ${id}`);
    return repo;
  }

  async add(folder: string, options: AddRepoOptions = {}): Promise<Repo> {
    let real: string;
    try {
      real = await fs.realpath(folder);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`${folder} does not exist`);
      }
      throw e;
    }
    const top = await this.git.toplevel(real);
    if (!top) throw new Error(`${folder} is not a git repository`);
    if (this.store.state.repos.some((r) => samePath(r.path, top))) {
      throw new Error(`${path.basename(top)} is already registered`);
    }
    if (options.writeConfig !== undefined) {
      try {
        await fs.writeFile(
          path.join(top, '.shellie.yml'),
          options.writeConfig,
          { encoding: 'utf8', flag: 'wx' },
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error(`${path.basename(top)}: .shellie.yml already exists`);
        throw e;
      }
    }
    const repo = await this.describe({
      id: randomUUID(),
      path: top,
      connectionId: options.connectionId ?? null,
      baseBranch: options.baseBranch,
      workItemOnStart: options.workItemOnStart
        ? StartSettingsSchema.parse(options.workItemOnStart)
        : undefined,
    });
    // Re-check inside the update: a concurrent add may have registered the same path while we awaited.
    await this.store.update((s) => {
      if (s.repos.some((r) => samePath(r.path, top))) {
        throw new Error(`${path.basename(top)} is already registered`);
      }
      s.repos.push(repo);
    });
    return repo;
  }

  /** Registers a repo Shellie found in a task (`discovered`); a repo already registered is returned unchanged. */
  async addDiscovered(
    folder: string,
    connectionId: string | null,
  ): Promise<Repo> {
    const top = await this.git.toplevel(await fs.realpath(folder));
    if (!top) throw new Error(`${folder} is not a git repository`);
    const known = () =>
      this.store.state.repos.find((r) => samePath(r.path, top));
    const existing = known();
    if (existing) return existing;
    const repo = await this.describe({
      id: randomUUID(),
      path: top,
      connectionId,
      discovered: true,
    });
    await this.store.update((s) => {
      if (!s.repos.some((r) => samePath(r.path, top))) s.repos.push(repo);
    });
    return known() ?? repo;
  }

  /** Clearing the mark makes a discovered repo a normal one. */
  setDiscovered(repoId: string, discovered: boolean): Promise<Repo> {
    return this.patch(repoId, (r) => {
      r.discovered = discovered;
    });
  }

  setConnection(repoId: string, connectionId: string | null): Promise<Repo> {
    return this.patch(repoId, (r) => {
      r.connectionId = connectionId;
    });
  }

  async setWorkItemOnStart(
    repoId: string,
    settings: StartSettings,
  ): Promise<Repo> {
    this.get(repoId);
    const parsed = StartSettingsSchema.parse(settings);
    return this.patch(repoId, (r) => {
      r.workItemOnStart = parsed;
    });
  }

  /** Stores a repo's own agent start commands, trimmed; an empty one is dropped, so the tab runs the default. */
  setAgentCommands(repoId: string, commands: AgentCommands): Promise<Repo> {
    const parsed = AgentCommandsSchema.parse(commands);
    const kept: AgentCommands = {};
    for (const key of ['claude', 'opencode'] as const) {
      const value = parsed[key]?.trim();
      if (value) kept[key] = value;
    }
    return this.patch(repoId, (r) => {
      r.agentCommands = kept;
    });
  }

  /** Re-reads name, base branch and .shellie.yml presence, e.g. after the user edits the file. */
  async refresh(id: string): Promise<Repo> {
    const current = this.get(id);
    const repo = await this.describe(current);
    await this.store.update((s) => {
      const i = s.repos.findIndex((r) => r.id === id);
      if (i >= 0) s.repos[i] = repo;
    });
    return repo;
  }

  async remove(id: string): Promise<void> {
    const open = this.store.state.tasks.filter(
      (t) => t.repoId === id && t.status !== 'done',
    );
    if (open.length > 0)
      throw new Error(
        `Repo still has ${open.length} open task(s); finish them first`,
      );
    await this.store.update((s) => {
      s.repos = s.repos.filter((r) => r.id !== id);
    });
  }

  /** A stored base branch if origin or the local repo has it; a stale one (e.g. a default `main` in a master repo) is null. */
  private async existingBase(
    repoPath: string,
    branch: string | undefined,
  ): Promise<string | null> {
    if (!branch) return null;
    if (await this.git.commitExists(repoPath, `refs/remotes/origin/${branch}`))
      return branch;
    if (await this.git.branchExists(repoPath, branch)) return branch;
    return null;
  }

  private async describe(
    base: Pick<Repo, 'id' | 'path' | 'connectionId'> &
      Partial<
        Pick<
          Repo,
          'workItemOnStart' | 'discovered' | 'baseBranch' | 'agentCommands'
        >
      >,
  ): Promise<Repo> {
    const config = await this.loadConfig(base.path);
    return {
      id: base.id,
      name: path.basename(base.path),
      path: base.path,
      // Without a config file the base branch Shellie was given (the inspected one) stays, as long as it exists.
      baseBranch: config.found
        ? config.base
        : ((await this.existingBase(base.path, base.baseBranch)) ??
          config.base),
      connectionId: base.connectionId,
      configFound: config.found,
      discovered: base.discovered ?? false,
      workItemOnStart: base.workItemOnStart ?? StartSettingsSchema.parse({}),
      ...(base.agentCommands && { agentCommands: base.agentCommands }),
    };
  }

  /** Changes one registered repo; throws for an unknown id. */
  private async patch(repoId: string, fn: (r: Repo) => void): Promise<Repo> {
    this.get(repoId);
    await this.store.update((s) => {
      const r = s.repos.find((x) => x.id === repoId);
      if (r) fn(r);
    });
    return this.get(repoId);
  }
}
