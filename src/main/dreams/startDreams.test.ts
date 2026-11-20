import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TaskSchema, type Task } from '../../shared/types';
import { dreamSessionsOf } from './startDreams';

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
    const texts = vi.fn(() => [[{ who: 'Developer' as const, text: 'hi' }]]);
    const out = await dreamSessionsOf([open, finished, other], 'r1', {
      sessionFile: (id) => (id === 's1' ? file : null),
      opencodeSessionTexts: texts,
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
      sessions: [[{ who: 'Developer', text: 'hi', at: null }]],
    });
  });
});
