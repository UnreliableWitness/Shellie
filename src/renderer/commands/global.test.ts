import { beforeEach, describe, expect, it } from 'vitest';
import type { Connection, TaskView } from '../../shared/types';
import { useStore } from '../store';
import { globalCommands } from './global';

const connection = (id: string, project: string) =>
  ({ id, name: 'acme', project, status: 'ok' }) as unknown as Connection;
const task = (over: Partial<TaskView>) =>
  ({
    id: 't',
    name: 'Rome invoices',
    status: 'ready',
    createdAt: '2026-11-01T09:00:00.000Z',
    connectionId: 'c1',
    repoId: null,
    terminals: [],
    workItem: null,
    ...over,
  }) as unknown as TaskView;

const commands = () => globalCommands(useStore.getState());
const ids = () => commands().map((c) => c.id);

describe('globalCommands', () => {
  beforeEach(() => {
    useStore.setState({
      screen: { kind: 'home' },
      connections: [connection('c1', 'Rome')],
      connectionId: 'c1',
      repos: [],
      tasks: [],
      selectedTaskId: null,
    });
  });

  it('gives the big places a key with Shift, each its own', () => {
    const keyed = commands().filter((c) => c.shortcut);
    expect(
      Object.fromEntries(keyed.map((c) => [c.id, c.shortcut!.code])),
    ).toEqual({
      'goto.home': 'KeyH',
      'goto.sprint': 'KeyS',
      'goto.week': 'KeyW',
      'goto.newTask': 'KeyN',
      'app.focus': 'KeyF',
    });
    expect(keyed.every((c) => c.shortcut!.shift)).toBe(true);
    // Not the keys taken elsewhere: the palette (P), a task's Docs (D), Brain and the project's brain (B), Dreams (M).
    const codes = [
      ...keyed.map((c) => c.shortcut!.code),
      'KeyP',
      'KeyD',
      'KeyB',
      'KeyM',
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('offers the places', () => {
    expect(ids()).toEqual(
      expect.arrayContaining([
        'goto.home',
        'goto.sprint',
        'goto.week',
        'goto.project',
        'goto.settings',
        'goto.newTask',
        'goto.secrets',
        'app.focus',
        'app.nav',
        'app.getStarted',
      ]),
    );
  });

  it('goes where a place command says', () => {
    commands()
      .find((c) => c.id === 'goto.sprint')
      ?.run();
    expect(useStore.getState().screen.kind).toBe('sprint');
  });

  it('has no Project and no switch without a second connection', () => {
    expect(ids().some((id) => id.startsWith('goto.connection.'))).toBe(false);
    useStore.setState({ connections: [], connectionId: null });
    expect(ids()).not.toContain('goto.project');
  });

  it('switches to the other project and stays on a page that follows it', () => {
    useStore.setState({
      connections: [connection('c1', 'Rome'), connection('c2', 'Oslo')],
      screen: { kind: 'sprint' },
    });
    const switches = commands().filter((c) =>
      c.id.startsWith('goto.connection.'),
    );
    expect(switches.map((c) => c.title)).toEqual([
      'Switch to project acme/Oslo',
    ]);
    switches[0].run();
    expect(useStore.getState().connectionId).toBe('c2');
    expect(useStore.getState().screen.kind).toBe('sprint');
  });

  it('goes Home on a switch from a page of the project left behind', () => {
    useStore.setState({
      connections: [connection('c1', 'Rome'), connection('c2', 'Oslo')],
      screen: { kind: 'brain', brainId: 'b1' },
    });
    commands()
      .find((c) => c.id.startsWith('goto.connection.'))
      ?.run();
    expect(useStore.getState().screen.kind).toBe('home');
  });

  it('Next project goes round the projects, and is not there with one', () => {
    expect(ids()).not.toContain('goto.nextProject');
    useStore.setState({
      connections: [connection('c1', 'Rome'), connection('c2', 'Oslo')],
      connectionId: 'c1',
      screen: { kind: 'home' },
    });
    const next = () =>
      commands()
        .find((c) => c.id === 'goto.nextProject')
        ?.run();
    next();
    expect(useStore.getState().connectionId).toBe('c2');
    next();
    expect(useStore.getState().connectionId).toBe('c1');
  });

  it("lists the active project's open tasks, newest first", () => {
    useStore.setState({
      connections: [connection('c1', 'Rome'), connection('c2', 'Oslo')],
      tasks: [
        task({
          id: 'old',
          name: 'Older',
          createdAt: '2026-11-01T09:00:00.000Z',
        }),
        task({
          id: 'new',
          name: 'Newer',
          createdAt: '2026-11-02T09:00:00.000Z',
        }),
        task({ id: 'done', name: 'Done one', status: 'done' }),
        task({ id: 'other', name: 'Elsewhere', connectionId: 'c2' }),
      ],
    });
    const tasks = commands().filter((c) => c.group === 'tasks');
    expect(tasks.map((c) => c.title)).toEqual(['Task Newer', 'Task Older']);
    tasks[1].run();
    expect(useStore.getState().selectedTaskId).toBe('old');
  });

  it('names a task by its work item', () => {
    useStore.setState({
      tasks: [
        task({
          workItem: { id: 412, title: 'Fix login redirect' },
        } as unknown as Partial<TaskView>),
      ],
    });
    expect(commands().find((c) => c.group === 'tasks')?.title).toBe(
      'Task 412: Fix login redirect',
    );
  });

  it('keeps names out of ids', () => {
    useStore.setState({
      connections: [connection('c1', 'Rome'), connection('c2', 'Oslo')],
      tasks: [task({ id: 'x', name: 'Rome invoices' })],
    });
    expect(ids().join(' ')).not.toMatch(/Rome|Oslo|acme|invoices/i);
  });
});
