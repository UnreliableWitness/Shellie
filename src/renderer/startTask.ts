import { useState } from 'react';
import type { AgentId } from '../shared/agents';
import { renderBranch } from '../shared/naming';
import { isGuarded } from '../shared/secrets';
import { setupTabsFrom } from '../shared/terminals';
import type { Repo, Task, WorkItemRef } from '../shared/types';
import { api, tryInvoke } from './api';
import { useStore } from './store';

/** The repos a Start for this connection can go to: linked ones, never discovered ones. */
export function reposForConnection(
  repos: Repo[],
  connectionId: string,
): Repo[] {
  return repos.filter((r) => r.connectionId === connectionId && !r.discovered);
}

/**
 * Creates a task for a work item with the repo's .shellie.yml defaults, the tabs chosen in Settings and the repo's
 * default environment, the same as New task with nothing changed. An `agent` opens that agent instead of the ones
 * ticked in Settings (the shell stays as Settings has it), so apm installs for it too (#313).
 */
export async function startTaskFor(
  repoId: string,
  workItem: WorkItemRef,
  notify: (level: 'error', message: string) => void,
  agent?: AgentId,
): Promise<Task | undefined> {
  const loaded = await tryInvoke(
    () =>
      Promise.all([
        api().invoke('repos:config', repoId),
        api().invoke('settings:get'),
        api().invoke('secrets:repoDefault', repoId),
      ]),
    notify,
  );
  if (!loaded) return undefined;
  const [{ config, fileError }, settings, repoDefault] = loaded;
  // repos:config is lenient for Settings; a task never starts on a broken file's defaults.
  if (fileError !== null) {
    notify('error', fileError);
    return undefined;
  }
  return tryInvoke(
    () =>
      api().invoke('tasks:create', {
        repoId,
        baseRef: `origin/${config.base}`,
        name: '',
        workItem,
        branch: renderBranch(config.branch, { workItem, name: '' }),
        copy: true,
        commands: config.setup,
        ...setupTabsFrom(
          agent
            ? {
                claude: agent === 'claude',
                copilot: agent === 'copilot',
                opencode: agent === 'opencode',
                shell: settings.defaultTerminals.shell,
              }
            : settings.defaultTerminals,
        ),
        // Start never puts a task on UAT or Production: those take New task and a confirm.
        environment: isGuarded(repoDefault) ? 'development' : repoDefault,
      }),
    notify,
  );
}

/**
 * Start on a work item row (Up next, Sprint): New task when `chooseRepo` (several repos share the project, so it asks
 * which one), else startTaskFor and the new task's setup. `starting` is true while the task is created.
 */
export function useStartTask(
  repoId: string | null,
  item: Omit<WorkItemRef, 'project'> & { project?: string | null },
  chooseRepo: boolean,
) {
  const go = useStore((s) => s.go);
  const select = useStore((s) => s.select);
  const notify = useStore((s) => s.notify);
  const [starting, setStarting] = useState(false);
  const start = async (agent?: AgentId) => {
    if (!repoId || starting) return;
    const workItem = {
      id: item.id,
      type: item.type,
      title: item.title,
      url: item.url,
      project: item.project ?? null,
    };
    if (chooseRepo) return go({ kind: 'new-task', workItem, repoId });
    setStarting(true);
    const created = await startTaskFor(repoId, workItem, notify, agent);
    setStarting(false);
    if (created) {
      select(created.id);
      go({ kind: 'setup', taskId: created.id });
    }
  };
  return { starting, start };
}
