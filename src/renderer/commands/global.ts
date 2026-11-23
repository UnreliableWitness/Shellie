import { activeConnection, type Store } from '../store';
import { listTasks } from '../taskList';
import { track } from '../telemetry';
import type { Command } from './types';

/**
 * The commands that need nothing but the store: the places, the active project's open tasks and the app's own
 * switches. What a mounted component knows (a task's brain, its editors, its run entries) that component offers
 * itself, through `useContributeCommands`.
 */
export function globalCommands(s: Store): Command[] {
  const connection = activeConnection(s);
  const { open } = listTasks(
    s.tasks,
    s.repos,
    connection?.id,
    s.connections.map((c) => c.id),
  );
  const place = (
    id: string,
    title: string,
    screen: Parameters<Store['go']>[0],
  ): Command => ({ id, title, group: 'goto', run: () => s.go(screen) });
  return [
    place('goto.home', 'Home', { kind: 'home' }),
    place('goto.sprint', 'Sprint', { kind: 'sprint' }),
    place('goto.week', 'Week', { kind: 'week' }),
    ...(connection
      ? [
          {
            ...place('goto.project', 'Project', { kind: 'project' }),
            run: () => {
              s.go({ kind: 'project' });
              track('project.open', { from: 'palette' });
            },
          },
        ]
      : []),
    place('goto.newTask', 'New task', { kind: 'new-task' }),
    place('goto.settings', 'Settings', { kind: 'settings' }),
    place('goto.secrets', 'Secrets', { kind: 'secrets' }),
    ...(s.connections.length > 1
      ? s.connections.flatMap((c, i): Command[] =>
          c.id === connection?.id
            ? []
            : [
                {
                  id: `goto.connection.${i}`,
                  title: `Switch to project ${c.name}/${c.project}`,
                  group: 'goto',
                  run: () => {
                    s.setConnectionId(c.id);
                    s.go({ kind: 'project' });
                    track('project.open', { from: 'palette' });
                  },
                },
              ],
        )
      : []),
    ...open.map((t, i): Command => ({
      id: `tasks.open.${i}`,
      title: t.workItem
        ? `Task ${t.workItem.id}: ${t.workItem.title}`
        : `Task ${t.name}`,
      group: 'tasks',
      run: () => s.openTask(t.id),
    })),
    {
      id: 'app.focus',
      title: 'Focus mode',
      group: 'app',
      shortcut: { code: 'KeyF', shift: true },
      run: () => s.toggleFocus(),
    },
    {
      id: 'app.nav',
      title: s.navCollapsed ? 'Expand navigation' : 'Collapse navigation',
      group: 'app',
      run: () => s.setNavCollapsed(!s.navCollapsed),
    },
    {
      id: 'app.getStarted',
      title: 'Get started',
      group: 'app',
      run: () => s.go({ kind: 'get-started' }),
    },
  ];
}
