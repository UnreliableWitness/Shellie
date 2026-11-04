import { describe, expect, it } from 'vitest';
import {
  ConnectionsFileSchema,
  SetupSummarySchema,
  StateSchema,
  WorkItemRefSchema,
} from './types';

describe('StateSchema', () => {
  it('reads a repo saved with miacYmlFound', () => {
    const s = StateSchema.parse({
      version: 1,
      repos: [
        {
          id: 'r',
          name: 'n',
          path: '/p',
          baseBranch: 'main',
          connectionId: null,
          miacYmlFound: true,
        },
      ],
      tasks: [],
    });
    expect(s.repos[0]?.configFound).toBe(true);
  });

  it('accepts an empty state', () => {
    expect(StateSchema.parse({ version: 1, repos: [], tasks: [] })).toEqual({
      version: 1,
      repos: [],
      tasks: [],
      // A state from before #124 has no discarded leftovers.
      discardedCleanup: [],
    });
  });
  it('rejects an unknown task status', () => {
    const bad = {
      version: 1,
      repos: [],
      tasks: [
        {
          id: 't',
          repoId: 'r',
          name: 'x',
          workItem: null,
          slug: 'x',
          branch: 'b',
          worktreePath: '/w',
          baseRef: 'main',
          status: 'weird',
          setup: {
            copy: false,
            commands: [],
            startClaude: false,
            openShell: false,
          },
          terminals: [],
          createdAt: 'now',
          finishedAt: null,
        },
      ],
    };
    expect(() => StateSchema.parse(bad)).toThrow();
  });
  it('rejects a future version', () => {
    expect(() =>
      StateSchema.parse({ version: 2, repos: [], tasks: [] }),
    ).toThrow();
  });
});

describe('WorkItemRefSchema', () => {
  it('accepts any type string and defaults url to null', () => {
    expect(
      WorkItemRefSchema.parse({ id: '7', type: 'Issue', title: 'x' }),
    ).toEqual({ id: '7', type: 'Issue', title: 'x', url: null, project: null });
  });
  it('WorkItemRef without project still parses', () => {
    expect(
      WorkItemRefSchema.parse({ id: '1', type: 'Bug', title: 't' }).project,
    ).toBeNull();
  });
  it('keeps the project when given', () => {
    expect(
      WorkItemRefSchema.parse({
        id: '1',
        type: 'Bug',
        title: 't',
        project: 'Acme',
      }).project,
    ).toBe('Acme');
  });
  it('keeps a url when given', () => {
    expect(
      WorkItemRefSchema.parse({
        id: '7',
        type: 'Bug',
        title: 'x',
        url: 'https://dev.azure.com/o/p/_workitems/edit/7',
      }).url,
    ).toContain('/edit/7');
  });
});

describe('SetupSummarySchema', () => {
  it('defaults brain to null on summaries from before it was recorded', () => {
    expect(
      SetupSummarySchema.parse({
        branch: 'b',
        base: 'main',
        copy: [],
        commands: [],
        apm: null,
        tabs: [],
        run: [],
        workItem: null,
        editor: null,
      }).brain,
    ).toBeNull();
  });
});

describe('ConnectionsFileSchema', () => {
  it('accepts an empty file and a connection with ciphertext', () => {
    expect(
      ConnectionsFileSchema.parse({ version: 1, connections: [] }).connections,
    ).toEqual([]);
    const c = {
      id: 'c1',
      name: 'unreliablewitness',
      organizationUrl: 'https://dev.azure.com/unreliablewitness',
      project: 'Shellie',
      user: null,
      status: 'unknown',
      checkedAt: null,
      userUniqueName: null,
      tokenCiphertext: 'AAAA',
    };
    expect(
      ConnectionsFileSchema.parse({ version: 1, connections: [c] })
        .connections[0].tokenCiphertext,
    ).toBe('AAAA');
  });
  it('rejects an unknown status', () => {
    expect(() =>
      ConnectionsFileSchema.parse({
        version: 1,
        connections: [
          {
            id: 'c',
            name: 'n',
            organizationUrl: 'u',
            project: 'p',
            user: null,
            status: 'weird',
            checkedAt: null,
            userUniqueName: null,
            tokenCiphertext: 'x',
          },
        ],
      }),
    ).toThrow();
  });
});

it('accepts a task saved before sub-project 3 and defaults the usage fields', async () => {
  const { TaskSchema } = await import('./types');
  const t = TaskSchema.parse({
    id: 't',
    repoId: 'r',
    name: 'x',
    workItem: null,
    slug: 'x',
    branch: 'b',
    worktreePath: '/w',
    baseRef: 'main',
    status: 'ready',
    setup: { copy: false, commands: [], startClaude: false, openShell: false },
    terminals: [],
    createdAt: 'now',
    finishedAt: null,
  });
  expect(t).toMatchObject({
    usageSyncedAt: null,
    usageSyncError: null,
    usageCommentId: null,
    summary: null,
    pullRequest: null,
    baseSha: null,
  });
});

it('reads a stored task with a repo as before, and one without a repo (#225)', async () => {
  const { TaskSchema } = await import('./types');
  const stored = {
    id: 't',
    name: 'Ask the brain',
    workItem: null,
    slug: 'ask-the-brain',
    worktreePath: '/data/scratch/ask-the-brain',
    status: 'ready',
    setup: { copy: false, commands: [], startClaude: true, openShell: true },
    terminals: [],
    createdAt: 'now',
    finishedAt: null,
  };
  expect(
    TaskSchema.parse({ ...stored, repoId: 'r', branch: 'b', baseRef: 'main' }),
  ).toMatchObject({ repoId: 'r', branch: 'b', baseRef: 'main' });
  expect(
    TaskSchema.parse({ ...stored, repoId: null, branch: '', baseRef: '' }),
  ).toMatchObject({ repoId: null, branch: '', baseRef: '' });
  expect(() =>
    TaskSchema.parse({ ...stored, repoId: '', branch: '', baseRef: '' }),
  ).toThrow();
});

it('loads a summary saved before baseKnown existed as a known base', async () => {
  const { TaskSummarySchema } = await import('./types');
  expect(
    TaskSummarySchema.parse({
      commits: [],
      commitCount: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      pushed: false,
      upstream: null,
    }).baseKnown,
  ).toBe(true);
});
