import { mkdtempSync, writeFileSync } from 'node:fs';
import {
  defaultDreaming,
  type DreamingAll,
  type DreamingSettings,
  type DreamSwitchedOff,
} from '../../shared/dreams';
import type { AppSettings } from '../../shared/usage';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TaskSchema, type Task } from '../../shared/types';
import { pickMaterial } from './material';
import { dreamSessionsOf, taskAgentWorking, toProjects } from './startDreams';

const T1 = Date.parse('2026-11-19T11:30:00.000Z');
const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';

const makeTask = (over: Partial<Task>): Task =>
  TaskSchema.parse({
    id: 't',
    repoId: 'r1',
    name: 'Fix login',
    workItem: null,
    slug: 'fix-login',
    branch: 'feature/x',
    worktreePath: '/w/x',
    baseRef: 'origin/main',
    status: 'ready',
    setup: {
      copy: false,
      commands: [],
      startClaude: false,
      openShell: false,
    },
    terminals: [],
    createdAt: '2026-11-19T10:00:00.000Z',
    finishedAt: null,
    ...over,
  });

describe('dreamSessionsOf', () => {
  it('gives the sessions of the repo’s open and finished tasks, Claude’s with their times', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dream-sessions-'));
    const file = path.join(dir, 's1.jsonl');
    writeFileSync(
      file,
      line({
        type: 'user',
        timestamp: '2026-11-19T11:00:00.000Z',
        message: { role: 'user', content: 'use the helper' },
      }),
    );
    const open = makeTask({
      id: 'open',
      workItem: {
        id: '42',
        type: 'Bug',
        title: 'Login fails',
        url: null,
        project: null,
      },
      terminals: [
        { id: 'a', kind: 'claude', label: 'Claude', sessionId: 's1' },
      ],
    });
    const finished = makeTask({
      id: 'done',
      status: 'done',
      finishedAt: '2026-11-19T12:00:00.000Z',
      closedTerminals: [{ id: 'b', kind: 'opencode', label: 'OpenCode' }],
    });
    const other = makeTask({ id: 'other', repoId: 'r2' });
    const texts = vi.fn(() => [
      [{ who: 'Developer' as const, text: 'hi', at: T1 }],
    ]);
    const out = await dreamSessionsOf([open, finished, other], 'r1', {
      sessionFile: (id) => (id === 's1' ? file : null),
      opencodeSessionTurns: texts,
    });
    expect(out.map((t) => t.taskId)).toEqual(['open', 'done']);
    expect(out[0]).toMatchObject({
      label: 'Login fails',
      workItemId: 42,
      agents: ['claude'],
      sessions: [
        [
          {
            who: 'Developer',
            text: 'use the helper',
            at: Date.parse('2026-11-19T11:00:00.000Z'),
          },
        ],
      ],
    });
    expect(out[1]).toMatchObject({
      label: 'Fix login',
      workItemId: null,
      agents: ['opencode'],
      sessions: [[{ who: 'Developer', text: 'hi', at: T1 }]],
    });
  });

  describe('an OpenCode-only task', () => {
    const oc = makeTask({
      id: 'oc',
      terminals: [{ id: 'o', kind: 'opencode', label: 'OpenCode' }],
    });
    const sessionsAt = (...times: number[]) =>
      dreamSessionsOf([oc], 'r1', {
        sessionFile: () => null,
        opencodeSessionTurns: () => [
          times.map((at) => ({ who: 'Developer' as const, text: 'x', at })),
        ],
      });

    it('is picked again for a developer turn after its mark, and its newest turn is the mark', async () => {
      const m = pickMaterial(await sessionsAt(T1, T1 + 5000), { oc: T1 });
      expect(m.tasks.map((t) => t.taskId)).toEqual(['oc']);
      expect(m.marks).toEqual({ oc: T1 + 5000 });
    });

    it('is not picked with turns before its mark only', async () => {
      const m = pickMaterial(await sessionsAt(T1 - 5000, T1), { oc: T1 });
      expect(m.tasks).toEqual([]);
    });
  });
});

describe('taskAgentWorking', () => {
  const t = makeTask({
    terminals: [
      { id: 'sh', kind: 'shell', label: 'Shell' },
      { id: 'cl', kind: 'claude', label: 'Claude' },
      { id: 'cp', kind: 'copilot', label: 'Copilot' },
    ],
  });
  const states = (m: Record<string, string>) => (id: string) =>
    (m[id] as 'working' | undefined) ?? null;

  it('is true for an agent tab of a task whose last state is working', () => {
    expect(taskAgentWorking([t], states({ cl: 'working' }))).toBe(true);
    expect(taskAgentWorking([t], states({ cp: 'working' }))).toBe(true);
    expect(taskAgentWorking([t], states({ cl: 'idle' }))).toBe(false);
  });

  it('ignores a shell tab (it has the attention route too) and tabs of no task, such as the brain terminal', () => {
    expect(
      taskAgentWorking([t], states({ sh: 'working', brain: 'working' })),
    ).toBe(false);
  });
});

describe('toProjects', () => {
  const block = (over: Partial<DreamingSettings> = {}): DreamingSettings => ({
    ...defaultDreaming(),
    enabled: true,
    model: 'zai/glm-5',
    testedModel: 'zai/glm-5',
    limit: { kind: 'tokens', perDay: 1000 },
    repos: {
      r1: { on: true, folders: ['.apm'] },
      r2: { on: true, folders: ['.apm'] },
    },
    ...over,
  });
  const make = (dreaming: DreamingAll) => {
    let all = dreaming;
    const writes = vi.fn();
    return {
      get: () => ({ dreaming: all }) as AppSettings,
      updateDreaming: async (fn: (d: DreamingAll) => DreamingAll) => {
        all = fn(all);
        writes();
      },
      all: () => all,
      writes,
    };
  };
  const noRecord = { adoptLegacySwitchedOff: async () => undefined };
  const repos = [
    { id: 'r1', connectionId: 'p1' },
    { id: 'r2', connectionId: 'p2' },
    { id: 'r3', connectionId: 'p3' },
  ];

  it('splits the old single setup over the projects of its repos and forgets it', async () => {
    const s = make({ projects: {}, legacy: block() });
    await toProjects(s, noRecord, repos);
    expect(s.all()).toEqual({
      projects: {
        p1: block({ repos: { r1: { on: true, folders: ['.apm'] } } }),
        p2: block({ repos: { r2: { on: true, folders: ['.apm'] } } }),
      },
      legacy: null,
    });
  });

  it('keeps a project that was set up since, over the copy', async () => {
    const own = block({ idleMinutes: 45, repos: {}, enabled: false });
    const s = make({ projects: { p1: own }, legacy: block() });
    await toProjects(s, noRecord, repos);
    expect(s.all().projects.p1).toEqual(own);
    expect(s.all().projects.p2.enabled).toBe(true);
  });

  it('keeps the old setup for the next start while no repo is known', async () => {
    const s = make({ projects: {}, legacy: block() });
    await toProjects(s, noRecord, []);
    expect(s.all()).toEqual({ projects: {}, legacy: block() });
    expect(s.writes).not.toHaveBeenCalled();
  });

  it('takes a repo out of the block of a project it no longer belongs to, and switches that block off when nothing is left', async () => {
    const s = make({
      projects: {
        p1: block({ repos: { r2: { on: true, folders: ['.apm'] } } }),
      },
      legacy: null,
    });
    await toProjects(s, noRecord, repos);
    expect(s.all().projects.p1).toMatchObject({ enabled: false, repos: {} });
  });

  it('gives the old switch-off record to its repo’s project, or to every project on its model when it names no repo', async () => {
    const s = make({
      projects: {
        p1: block(),
        p2: block(),
        p3: block({ model: 'zai/other' }),
      },
      legacy: null,
    });
    const asked: string[][] = [];
    const store = (record: DreamSwitchedOff) => ({
      adoptLegacySwitchedOff: async (
        projectsOf: (r: DreamSwitchedOff) => string[],
      ) => {
        asked.push(projectsOf(record));
      },
    });
    const of = { answered: 'x/y', chosen: 'zai/glm-5' };
    await toProjects(s, store({ ...of, repoId: 'r2' }), repos);
    await toProjects(s, store({ ...of, repoId: '' }), repos);
    await toProjects(s, store({ ...of, repoId: 'gone' }), repos);
    expect(asked).toEqual([['p2'], ['p1', 'p2'], ['p1', 'p2']]);
  });
});
