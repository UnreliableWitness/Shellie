import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../../services/GitClient';
import { OUTSIDE_EDIT_MESSAGE } from '../brainHandlers';
import { scaffoldBrain } from '../scaffold';
import {
  isPersonFree,
  JOIN_MESSAGE,
  KEEPER_MESSAGE,
  MERGE_MESSAGE,
  parseJobSubject,
  SHARE_MESSAGE,
  SHARED_FACTS_MESSAGE,
  SQUASH_MESSAGE,
} from '../brainCommits';
import { mergeServer } from './merge';

// real git, many subprocesses per test: slow under load and on the Windows runner
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const git = new GitClient();
const NOW = new Date('2026-11-13T10:00:00Z');

let root: string;
let a: string;
let b: string;

const write = async (dir: string, rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text);
};
const read = (dir: string, rel: string) =>
  fs.readFile(path.join(dir, rel), 'utf8');
const commit = async (dir: string, message: string) => {
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-q', '-m', message]);
};
const push = (dir: string) => git.run(dir, ['push', '-q', 'origin', 'main']);
const fetch = (dir: string) => git.run(dir, ['fetch', '-q', 'origin']);
const json = async (dir: string, rel: string) =>
  JSON.parse(await read(dir, rel)) as Record<string, unknown>;

/** B's change goes to the server first; A fetches and merges it. */
async function serverThenMerge() {
  await push(b);
  await fetch(a);
  return mergeServer(git, a, 'origin/main', NOW);
}

async function expectCleanTree(dir: string) {
  expect(await git.run(dir, ['status', '--porcelain'])).toBe('');
  const markers = await git
    .run(dir, ['grep', '-n', '^<<<<<<<'])
    .catch(() => '');
  expect(markers).toBe('');
}

const parents = async (dir: string) =>
  (await git.run(dir, ['log', '-1', '--format=%P'])).trim().split(' ');

const PAGE = (lines: string[]) =>
  `---\ntype: topic\n---\n# X\n\n${lines.join('\n')}\n`;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-merge-'));
  const seed = path.join(root, 'seed');
  const server = path.join(root, 'server.git');
  await scaffoldBrain(git, seed, 'Acme');
  await write(seed, 'wiki/x.md', PAGE(['one', 'two', 'three', 'four', 'five']));
  await commit(seed, 'Brain: capture sources/seed.md');
  await git.run(root, ['init', '-q', '--bare', '-b', 'main', server]);
  await git.run(seed, ['remote', 'add', 'origin', server]);
  await push(seed);
  a = path.join(root, 'a');
  b = path.join(root, 'b');
  for (const dir of [a, b]) {
    await git.run(root, ['clone', '-q', server, dir]);
    await git.run(dir, ['config', 'user.name', 'Shellie']);
    await git.run(dir, ['config', 'user.email', 'shellie@localhost']);
  }
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('isPersonFree', () => {
  it("knows Shellie's own person-free commits by their constants, and not the fold", () => {
    for (const s of [
      MERGE_MESSAGE,
      JOIN_MESSAGE,
      KEEPER_MESSAGE,
      SHARED_FACTS_MESSAGE,
      SHARE_MESSAGE,
      'Brain: index',
      'Brain: verified wiki/x.md',
    ])
      expect(isPersonFree(s)).toBe(true);
    for (const s of [SQUASH_MESSAGE, 'Brain: scrub', OUTSIDE_EDIT_MESSAGE])
      expect(isPersonFree(s)).toBe(false);
  });
});

describe('parseJobSubject', () => {
  it('reads a job from its commit subject', () => {
    expect(parseJobSubject('Brain: capture sources/a.md')).toEqual({
      kind: 'capture',
      source: 'sources/a.md',
      target: null,
    });
    expect(parseJobSubject('Brain: write reads/x.md')).toEqual({
      kind: 'write',
      source: null,
      target: 'reads/x.md',
    });
    expect(parseJobSubject('Brain: write chapter:Orders and returns')).toEqual({
      kind: 'write',
      source: null,
      target: 'chapter:Orders and returns',
    });
    expect(parseJobSubject('Brain: sync')).toEqual({
      kind: 'sync',
      source: null,
      target: null,
    });
    expect(parseJobSubject('Brain: write')).toEqual({
      kind: 'write',
      source: null,
      target: null,
    });
  });

  it('reads a settle job with its conflict id as the target', () => {
    expect(parseJobSubject('Brain: settle c1')).toEqual({
      kind: 'settle',
      source: null,
      target: 'c1',
    });
  });

  it('is null for other commits', () => {
    for (const s of [
      'Brain: index',
      'Brain: settle conflict',
      'Brain: retry settle',
      'Brain: add source a.md',
      'Brain: verified wiki/x.md',
      'Brain: refresh wiki mirror (+1 ~0 -0)',
      'Brain: merge from colleagues',
      'Brain created',
      OUTSIDE_EDIT_MESSAGE,
      'Fix a typo',
    ])
      expect(parseJobSubject(s)).toBeNull();
  });
});

describe('mergeServer', () => {
  it('(a) merges two new sources cleanly', async () => {
    await write(a, 'sources/a.md', 'from A\n');
    await commit(a, 'Brain: add source a.md');
    await write(b, 'sources/b.md', 'from B\n');
    await commit(b, 'Brain: add source b.md');
    const r = await serverThenMerge();
    expect(r).toEqual({ merged: true, rerun: [], notes: [] });
    expect(await read(a, 'sources/a.md')).toBe('from A\n');
    expect(await read(a, 'sources/b.md')).toBe('from B\n');
    expect(await parents(a)).toHaveLength(2);
    expect((await git.run(a, ['log', '-1', '--format=%s'])).trim()).toBe(
      'Brain: merge from colleagues',
    );
    await expectCleanTree(a);
  });

  it('(b) takes the server side of a job clash and asks for the job again', async () => {
    await write(
      a,
      'wiki/x.md',
      PAGE(['one', 'TWO by A', 'three', 'four', 'five']),
    );
    await commit(a, 'Brain: capture sources/a.md');
    await write(
      b,
      'wiki/x.md',
      PAGE(['one', 'TWO by B', 'three', 'four', 'five']),
    );
    await commit(b, 'Brain: capture sources/b.md');
    const r = await serverThenMerge();
    expect(r).toEqual({
      merged: true,
      rerun: [{ kind: 'capture', source: 'sources/a.md', target: null }],
      notes: [],
    });
    expect(await read(a, 'wiki/x.md')).toContain('TWO by B');
    expect(await read(a, 'wiki/x.md')).not.toContain('TWO by A');
    expect(await parents(a)).toHaveLength(2);
    await expectCleanTree(a);
  });

  it('(c) lets git merge changes to different parts of the same page', async () => {
    await write(
      a,
      'wiki/x.md',
      PAGE(['ONE by A', 'two', 'three', 'four', 'five']),
    );
    await commit(a, 'Brain: capture sources/a.md');
    await write(
      b,
      'wiki/x.md',
      PAGE(['one', 'two', 'three', 'four', 'FIVE by B']),
    );
    await commit(b, 'Brain: capture sources/b.md');
    const r = await serverThenMerge();
    expect(r).toEqual({ merged: true, rerun: [], notes: [] });
    expect(await read(a, 'wiki/x.md')).toBe(
      PAGE(['ONE by A', 'two', 'three', 'four', 'FIVE by B']),
    );
    await expectCleanTree(a);
  });

  it('(d) keeps a clashing outside edit as a source note', async () => {
    await write(
      a,
      'wiki/x.md',
      PAGE(['one', 'two edited by hand', 'three', 'four', 'five']),
    );
    await commit(a, OUTSIDE_EDIT_MESSAGE);
    await write(
      b,
      'wiki/x.md',
      PAGE(['one', 'TWO by B', 'three', 'four', 'five']),
    );
    await commit(b, 'Brain: capture sources/b.md');
    const r = await serverThenMerge();
    const note = 'sources/notes/2026-11-13-x-local.md';
    expect(r).toEqual({ merged: true, rerun: [], notes: [note] });
    expect(await read(a, 'wiki/x.md')).toContain('TWO by B');
    expect(await read(a, note)).toContain('two edited by hand');
    expect(await read(a, note)).toContain('wiki/x.md');
    await expectCleanTree(a);
  });

  it('(e) merges the brain files by rule, with no conflict markers left', async () => {
    const seedFiles = async (dir: string) => {
      await write(
        dir,
        'brain/conflicts.json',
        JSON.stringify({ version: 1, conflicts: {} }, null, 2) + '\n',
      );
      await write(
        dir,
        'brain/book.json',
        JSON.stringify(
          {
            chapters: [
              { title: 'Start', summary: '', intro: '', pages: ['wiki/x.md'] },
            ],
          },
          null,
          2,
        ) + '\n',
      );
      await write(
        dir,
        'brain/reads.json',
        JSON.stringify({ reads: {} }, null, 2) + '\n',
      );
    };
    await seedFiles(a);
    await commit(a, 'Brain: seed files');
    await push(a);
    await git.run(b, ['pull', '-q', 'origin', 'main']);

    const side = async (dir: string, who: 'A' | 'B', at: string) => {
      await write(dir, 'log.md', `# Log\n\n- ${at} capture by ${who}\n`);
      await write(
        dir,
        'brain/state.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            lastSyncCommit: null,
            lastLintAt:
              who === 'A' ? '2026-11-12T00:00:00Z' : '2026-11-11T00:00:00Z',
            captured: { [`sources/${who}.md`]: { at, sessionId: null } },
            findings: [],
          },
          null,
          2,
        ) + '\n',
      );
      await write(
        dir,
        'brain/conflicts.json',
        JSON.stringify(
          {
            version: 1,
            conflicts: {
              [`c${who}`]: { parked: { at } },
            },
          },
          null,
          2,
        ) + '\n',
      );
      await write(
        dir,
        'brain/book.json',
        JSON.stringify(
          {
            chapters: [
              {
                title: 'Start',
                summary: '',
                intro: '',
                pages: ['wiki/x.md', `wiki/${who}.md`],
              },
            ],
          },
          null,
          2,
        ) + '\n',
      );
      await write(
        dir,
        'brain/reads.json',
        JSON.stringify(
          { reads: { [`reads/${who}.md`]: { at, pages: {} } } },
          null,
          2,
        ) + '\n',
      );
      await commit(dir, 'Brain: sync');
    };
    await side(a, 'A', '2026-11-13T09:00:00Z');
    await side(b, 'B', '2026-11-13T08:00:00Z');
    const r = await serverThenMerge();
    expect(r.merged).toBe(true);
    expect(r.notes).toEqual([]);
    await expectCleanTree(a);

    expect(await read(a, 'log.md')).toBe(
      '# Log\n\n- 2026-11-13T09:00:00Z capture by A\n- 2026-11-13T08:00:00Z capture by B\n',
    );
    const state = await json(a, 'brain/state.json');
    expect(Object.keys(state.captured as object).sort()).toEqual([
      'sources/A.md',
      'sources/B.md',
    ]);
    expect(state.lastLintAt).toBe('2026-11-12T00:00:00Z');
    const conflicts = await json(a, 'brain/conflicts.json');
    expect(Object.keys(conflicts.conflicts as object).sort()).toEqual([
      'cA',
      'cB',
    ]);
    const book = (await json(a, 'brain/book.json')) as {
      chapters: { pages: string[] }[];
    };
    expect(book.chapters[0].pages).toEqual([
      'wiki/x.md',
      'wiki/B.md',
      'wiki/A.md',
    ]);
    const reads = (await json(a, 'brain/reads.json')) as { reads: object };
    expect(Object.keys(reads.reads).sort()).toEqual([
      'reads/A.md',
      'reads/B.md',
    ]);
  });

  it('(f) merges several local commits at once and reruns only the job', async () => {
    await write(a, 'sources/n.md', 'a note\n');
    await commit(a, 'Brain: add source n.md');
    await write(
      a,
      'wiki/x.md',
      PAGE(['one', 'TWO by A', 'three', 'four', 'five']),
    );
    await commit(a, 'Brain: capture sources/n.md');
    await write(
      a,
      'wiki/x.md',
      PAGE(['one', 'TWO by A, then by hand', 'three', 'four', 'five']),
    );
    await commit(a, OUTSIDE_EDIT_MESSAGE);
    await write(
      b,
      'wiki/x.md',
      PAGE(['one', 'TWO by B', 'three', 'four', 'five']),
    );
    await commit(b, 'Brain: capture sources/b.md');
    const before = (await git.run(a, ['rev-parse', 'HEAD'])).trim();
    const r = await serverThenMerge();
    expect(r.rerun).toEqual([
      { kind: 'capture', source: 'sources/n.md', target: null },
    ]);
    expect(r.notes).toEqual(['sources/notes/2026-11-13-x-local.md']);
    const commits = (
      await git.run(a, ['rev-list', '--merges', `${before}..HEAD`])
    ).trim();
    expect(commits.split('\n')).toHaveLength(1);
    expect(await read(a, 'sources/n.md')).toBe('a note\n');
    expect(await read(a, 'wiki/x.md')).toContain('TWO by B');
    await expectCleanTree(a);
  });

  it("counts neither an earlier merge nor Shellie's own commits as an outside edit", async () => {
    await write(
      a,
      'wiki/x.md',
      PAGE(['one', 'TWO by A', 'three', 'four', 'five']),
    );
    await commit(a, 'Brain: capture sources/a.md');
    await write(b, 'sources/b.md', 'B\n');
    await commit(b, 'Brain: add source b.md');
    expect((await serverThenMerge()).notes).toEqual([]);
    await write(
      a,
      'wiki/x.md',
      PAGE(['one', 'TWO by A', 'three', 'four', 'five', 'verified']),
    );
    await commit(a, 'Brain: verified wiki/x.md');
    await git.run(b, ['pull', '-q', 'origin', 'main']);
    await write(
      b,
      'wiki/x.md',
      PAGE(['one', 'TWO by B', 'three', 'four', 'five']),
    );
    await commit(b, 'Brain: capture sources/b.md');
    const r = await serverThenMerge();
    expect(r).toEqual({
      merged: true,
      rerun: [{ kind: 'capture', source: 'sources/a.md', target: null }],
      notes: [],
    });
    await expectCleanTree(a);
  });

  it('asks for a write job again by its target when a read clashes', async () => {
    await write(a, 'reads/r.md', 'A read\n');
    await write(b, 'reads/r.md', 'B read\n');
    await commit(a, 'Brain: write chapter:Orders');
    await commit(b, 'Brain: write chapter:Orders');
    const r = await serverThenMerge();
    expect(r.rerun).toEqual([
      { kind: 'write', source: null, target: 'chapter:Orders' },
    ]);
    expect(await read(a, 'reads/r.md')).toBe('B read\n');
    await expectCleanTree(a);
  });

  it('keeps both sides of a source clash, the local one renamed; the mirror takes the server', async () => {
    await write(a, 'sources/s.md', 'A\n');
    await write(a, 'sources/wiki/p.md', 'A\n');
    await commit(a, 'Brain: add source s.md');
    await write(b, 'sources/s.md', 'B\n');
    await write(b, 'sources/wiki/p.md', 'B\n');
    await commit(b, 'Brain: add source s.md');
    const r = await serverThenMerge();
    expect(r).toEqual({ merged: true, rerun: [], notes: [] });
    expect(await read(a, 'sources/s.md')).toBe('B\n');
    expect(await read(a, 'sources/s-local.md')).toBe('A\n');
    expect(await read(a, 'sources/wiki/p.md')).toBe('B\n');
    await expect(read(a, 'sources/wiki/p-local.md')).rejects.toThrow();
    await expectCleanTree(a);
  });

  it('picks a free name for the local side when <name>-local is taken', async () => {
    await write(a, 'sources/s-local.md', 'kept\n');
    await commit(a, 'Brain: add source s-local.md');
    await push(a);
    await git.run(b, ['pull', '-q', 'origin', 'main']);
    await write(a, 'sources/s.md', 'A\n');
    await commit(a, 'Brain: add source s.md');
    await write(b, 'sources/s.md', 'B\n');
    await commit(b, 'Brain: add source s.md');
    await serverThenMerge();
    expect(await read(a, 'sources/s-local.md')).toBe('kept\n');
    expect(await read(a, 'sources/s-local-2.md')).toBe('A\n');
    expect(await read(a, 'sources/s.md')).toBe('B\n');
    await expectCleanTree(a);
  });

  it.each([
    'Brain: changes since the last send',
    'Brain: task closed',
    'Brain: something a newer Shellie makes',
  ])(
    'keeps the local text of a clashing page from %j as a source note',
    async (subject) => {
      await write(
        a,
        'wiki/x.md',
        PAGE(['one', 'two edited by hand', 'three', 'four', 'five']),
      );
      await commit(a, subject);
      await write(
        b,
        'wiki/x.md',
        PAGE(['one', 'TWO by B', 'three', 'four', 'five']),
      );
      await commit(b, 'Brain: capture sources/b.md');
      const r = await serverThenMerge();
      expect(r.notes).toEqual(['sources/notes/2026-11-13-x-local.md']);
      expect(await read(a, r.notes[0])).toContain('two edited by hand');
      await expectCleanTree(a);
    },
  );

  it.each([
    'Brain: index',
    'Brain: verified wiki/x.md',
    'Brain: shared facts',
    'Brain: keeper',
    'Brain: joined',
    'Brain: shared',
  ])(
    'writes no note for %j, a commit with no person in it',
    async (subject) => {
      await write(
        a,
        'wiki/x.md',
        PAGE(['one', 'two by Shellie', 'three', 'four', 'five']),
      );
      await commit(a, subject);
      await write(
        b,
        'wiki/x.md',
        PAGE(['one', 'TWO by B', 'three', 'four', 'five']),
      );
      await commit(b, 'Brain: capture sources/b.md');
      expect((await serverThenMerge()).notes).toEqual([]);
      await expectCleanTree(a);
    },
  );

  it("keeps the scrubbed page when the server's still holds the scrubbed value", async () => {
    const SECRET = 'hunter2-very-secret';
    await write(
      a,
      'wiki/x.md',
      PAGE(['one', `pw ${SECRET}`, 'three', 'four', 'five']),
    );
    await commit(a, 'Brain: capture sources/a.md');
    await push(a);
    await git.run(b, ['pull', '-q', 'origin', 'main']);
    await write(
      a,
      'wiki/x.md',
      PAGE(['one', 'pw REDACTED', 'three', 'four', 'five']),
    );
    await commit(a, 'Brain: scrub');
    await write(
      b,
      'wiki/x.md',
      PAGE(['one', `pw ${SECRET} (B)`, 'three', 'four', 'five']),
    );
    await commit(b, 'Brain: capture sources/b.md');
    const r = await serverThenMerge();
    expect(await read(a, 'wiki/x.md')).not.toContain(SECRET);
    expect(await read(a, 'wiki/x.md')).toContain('pw REDACTED');
    // No note of a scrubbed page: nothing of it is lost, and nothing goes back in.
    expect(r.notes).toEqual([]);
    await expectCleanTree(a);
  });

  it("takes the server's page over a scrub when it no longer holds the value, keeping a note", async () => {
    const SECRET = 'hunter2-very-secret';
    await write(
      a,
      'wiki/x.md',
      PAGE(['one', `pw ${SECRET}`, 'three', 'four', 'five']),
    );
    await commit(a, 'Brain: capture sources/a.md');
    await push(a);
    await git.run(b, ['pull', '-q', 'origin', 'main']);
    await write(
      a,
      'wiki/x.md',
      PAGE(['one', 'pw REDACTED', 'three', 'four', 'five']),
    );
    await commit(a, 'Brain: scrub');
    await write(
      b,
      'wiki/x.md',
      PAGE(['one', 'rewritten by B', 'three', 'four', 'five']),
    );
    await commit(b, 'Brain: capture sources/b.md');
    const r = await serverThenMerge();
    expect(await read(a, 'wiki/x.md')).toContain('rewritten by B');
    expect(r.notes).toHaveLength(1);
    expect(await read(a, r.notes[0])).not.toContain(SECRET);
    await expectCleanTree(a);
  });

  it('takes the skills of the side with the higher templates version', async () => {
    const shared = (v: number) =>
      JSON.stringify({
        format: 1,
        wiki: null,
        lastRefreshAt: null,
        lastDigestAt: null,
        templatesVersion: v,
        updatedAt: {
          wiki: '1970-01-01T00:00:00.000Z',
          lastRefreshAt: '1970-01-01T00:00:00.000Z',
          lastDigestAt: '1970-01-01T00:00:00.000Z',
          templatesVersion: `2026-11-1${v - 9}T00:00:00.000Z`,
        },
      }) + '\n';
    await write(a, 'SCHEMA.md', 'A schema v11\n');
    await write(a, 'brain/shared.json', shared(11));
    await commit(a, 'Brain: update skills to v11');
    await write(b, 'SCHEMA.md', 'B schema v10\n');
    await write(b, 'brain/shared.json', shared(10));
    await commit(b, 'Brain: update skills to v10');
    await serverThenMerge();
    expect(await read(a, 'SCHEMA.md')).toBe('A schema v11\n');
    expect((await json(a, 'brain/shared.json')).templatesVersion).toBe(11);
    await expectCleanTree(a);
  });

  it('rebuilds index.md after taking the server side', async () => {
    await write(a, 'index.md', '# Acme brain\n\nA index\n');
    await commit(a, 'Brain: index');
    await write(b, 'index.md', '# Acme brain\n\nB index\n');
    await write(b, 'wiki/y.md', '---\ntype: topic\n---\n# Y\n');
    await commit(b, 'Brain: index');
    await serverThenMerge();
    const index = await read(a, 'index.md');
    expect(index).not.toContain('<<<<<<<');
    expect(index).toContain('wiki/y.md');
    await expectCleanTree(a);
  });

  it('reports nothing to merge when already up to date', async () => {
    await write(a, 'sources/a.md', 'A\n');
    await commit(a, 'Brain: add source a.md');
    await fetch(a);
    expect(await mergeServer(git, a, 'origin/main', NOW)).toEqual({
      merged: false,
      rerun: [],
      notes: [],
    });
  });

  it('fast-forwards when there is nothing local', async () => {
    await write(b, 'sources/b.md', 'B\n');
    await commit(b, 'Brain: add source b.md');
    const r = await serverThenMerge();
    expect(r).toEqual({ merged: true, rerun: [], notes: [] });
    expect(await read(a, 'sources/b.md')).toBe('B\n');
    await expectCleanTree(a);
  });

  it('aborts the merge when a brain file cannot be read, leaving the tree clean', async () => {
    await write(
      a,
      'brain/state.json',
      '{"schemaVersion":1,"lastLintAt":"x"}\n',
    );
    await commit(a, 'Brain: lint');
    await write(b, 'brain/state.json', '{ not json\n');
    await commit(b, 'Brain: lint');
    const head = (await git.run(a, ['rev-parse', 'HEAD'])).trim();
    await expect(serverThenMerge()).rejects.toThrow();
    expect((await git.run(a, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    await expectCleanTree(a);
    await expect(
      git.run(a, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']),
    ).rejects.toThrow();
  });
});
