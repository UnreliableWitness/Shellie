import { activeConnection, type Store, useStore } from '../store';
import { listTasks } from '../taskList';
import { track } from '../telemetry';
import type { Command, Shortcut } from './types';

/**
 * Focus mode: the one command with a shortcut that needs no component. It reads the store when it runs, so the
 * shortcut handler and the task menu can hold it without building the rest of the store's commands.
 */
export function focusCommand(): Command {
  return {
    id: 'app.focus',
    title: 'Focus mode',
    group: 'app',
    shortcut: { code: 'KeyF', shift: true },
    run: () => useStore.getState().toggleFocus(),
  };
}

type Screen = Parameters<Store['go']>[0];

/**
 * The places every project has, with their keys: Mod+Shift and a letter, since Mod and a letter alone belongs to
 * the shell on Windows (Ctrl+S, Ctrl+W) and to the window on macOS (Cmd+W, Cmd+H). Dreams (M, for its moon) and
 * the project's brain (B) are offered by `usePlaceCommands`, which knows whether the project has them.
 */
const PLACES: { id: string; title: string; screen: Screen; code?: string }[] = [
  { id: 'goto.home', title: 'Home', screen: { kind: 'home' }, code: 'KeyH' },
  {
    id: 'goto.sprint',
    title: 'Sprint',
    screen: { kind: 'sprint' },
    code: 'KeyS',
  },
  { id: 'goto.week', title: 'Week', screen: { kind: 'week' }, code: 'KeyW' },
  {
    id: 'goto.newTask',
    title: 'New task',
    screen: { kind: 'new-task' },
    code: 'KeyN',
  },
  { id: 'goto.settings', title: 'Settings', screen: { kind: 'settings' } },
  { id: 'goto.secrets', title: 'Secrets', screen: { kind: 'secrets' } },
];
export const DREAMS_SHORTCUT: Shortcut = { code: 'KeyM', shift: true };
export const BRAIN_SHORTCUT: Shortcut = { code: 'KeyB', shift: true };

const placeCommand = (
  p: (typeof PLACES)[number],
  go: (screen: Screen) => void,
): Command => ({
  id: p.id,
  title: p.title,
  group: 'goto',
  ...(p.code ? { shortcut: { code: p.code, shift: true } } : {}),
  run: () => go(p.screen),
});

/**
 * The places with a key, for the shortcut handler: built once, and they read the store when they run, so asking
 * on every key press with the mod key down costs nothing.
 */
const PLACE_SHORTCUTS: Command[] = PLACES.filter((p) => p.code).map((p) =>
  placeCommand(p, (screen) => useStore.getState().go(screen)),
);
export const placeShortcutCommands = (): Command[] => PLACE_SHORTCUTS;

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
  const place = (id: string): Command =>
    placeCommand(
      PLACES.find((p) => p.id === id)!,
      s.go,
    );
  return [
    place('goto.home'),
    place('goto.sprint'),
    place('goto.week'),
    ...(connection
      ? [
          {
            id: 'goto.project',
            title: 'Project',
            group: 'goto' as const,
            run: () => {
              s.go({ kind: 'project' });
              track('project.open', { from: 'palette' });
            },
          },
        ]
      : []),
    place('goto.newTask'),
    place('goto.settings'),
    place('goto.secrets'),
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
    focusCommand(),
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
