import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TaskSchema, type Task } from '../../shared/types';
import { pickMaterial } from './material';
import { dreamSessionsOf, taskAgentWorking } from './startDreams';

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
