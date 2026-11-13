import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrainSchema,
  type BrainJob,
  type BrainJobKind,
} from '../../../shared/brain';
import { GitAuthError, GitClient } from '../../services/GitClient';
import { BrainStore } from '../BrainStore';
import { commitJobOutput, OUTSIDE_EDIT_MESSAGE } from '../brainHandlers';
import { onBrainGitIdle, withBrainGit } from '../gitMutex';
import { scaffoldBrain } from '../scaffold';
import { scrubBrain } from '../scrub';
import { acquireLock, readState, releaseLock, writeState } from '../state';
import {
  BrainSync,
  RAN_AGAIN,
  SQUASH_MESSAGE,
  unquoteGitPath,
  type SyncRunner,
} from './BrainSync';
import { writeOrigin } from './files';

const git = new GitClient();
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

let root: string;
let server: string;
let a: string;
let b: string;
let brains: BrainStore;
let changed: string[];
let offs: (() => void)[];

const write = async (dir: string, rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text);
};
const exists = (dir: string, rel: string) =>
  fs.access(path.join(dir, rel)).then(
    () => true,
    () => false,
  );
const commit = async (
  dir: string,
  message: string,
  env?: Record<string, string>,
) => {
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-q', '-m', message], { env });
};
const pushB = () => git.run(b, ['push', '-q', 'origin', 'main']);
const head = async (dir: string) =>
  (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
const serverHead = async () =>
  (await git.run(root, ['--git-dir', server, 'rev-parse', 'main'])).trim();
const serverLog = () =>
  git.run(root, ['--git-dir', server, 'log', '-p', '--all']);
const PAGE = (line: string) =>
  `---\ntype: topic\n---\n# X\n\none\n${line}\nthree\n`;

/** A runner that records what is queued and failed, never running anything. */
function fakeRunner() {
  const list: BrainJob[] = [];
  const queued: [BrainJobKind, string | null, unknown][] = [];
  const failed: [string, string][] = [];
  const state = { busy: false };
  let n = 0;
  const runner: SyncRunner = {
    enqueue: (brainId, kind, source = null, opts) => {
      queued.push([kind, source, opts ?? {}]);
      const job = record(brainId, kind, source, 'queued', opts?.replays ?? 0);
      if (opts?.target) job.target = opts.target;
      list.unshift(job);
      return job;
    },
    jobs: () => [...list],
    running: () => state.busy,
    fail: (_id, jobId, error) => {
      failed.push([jobId, error]);
      return true;
    },
  };
  function record(
    brainId: string,
    kind: BrainJobKind,
    source: string | null,
    status: BrainJob['status'],
    replays: number,
  ): BrainJob {
    return {
      id: `j${++n}`,
      brainId,
      kind,
      source,
      status,
      startedAt: null,
      endedAt: null,
      sessionId: null,
      result: null,
      error: null,
      background: false,
      agent: 'claude',
      model: null,
      replays,
    };
  }
  /** A job that ran already, as the runner's list keeps it. */
  const ran = (kind: BrainJobKind, source: string | null, replays: number) => {
    const job = record('a', kind, source, 'done', replays);
    list.unshift(job);
    return job;
  };
  return { runner, queued, failed, ran, state };
}

let fake: ReturnType<typeof fakeRunner>;

function sync(
  over: Partial<ConstructorParameters<typeof BrainSync>[0]> = {},
): BrainSync {
  return new BrainSync({
    brains,
    git,
    runner: () => fake.runner,
    changed: (id) => changed.push(id),
    commitOutsideEdits: (id) =>
      commitJobOutput(
        git,
        brains.get(id)?.path ?? '',
        OUTSIDE_EDIT_MESSAGE,
        'Acme',
      ),
    pushDelayMs: 20,
    ...over,
  });
}

const sharing = () => brains.get('a')?.sharing;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-sync-'));
  const seed = path.join(root, 'seed');
  server = path.join(root, 'server.git');
  await scaffoldBrain(git, seed, 'Acme');
  await writeOrigin(seed, {
    format: 1,
    organizationUrl: 'https://dev.azure.com/o',
    project: 'p',
    name: 'Acme',
    keeper: { installId: 'keeper-1', name: 'Dries' },
    sharedAt: '2026-11-13T09:00:00.000Z',
  });
  await write(seed, 'wiki/x.md', PAGE('two'));
  await commit(seed, 'Brain: capture sources/seed.md');
  await git.run(root, ['init', '-q', '--bare', '-b', 'main', server]);
  await git.run(seed, ['remote', 'add', 'origin', server]);
  await git.run(seed, ['push', '-q', 'origin', 'main']);
  a = path.join(root, 'a');
  b = path.join(root, 'b');
  for (const dir of [a, b]) {
    await git.run(root, ['clone', '-q', server, dir]);
    await git.run(dir, ['config', 'user.name', 'Shellie']);
    await git.run(dir, ['config', 'user.email', 'shellie@localhost']);
  }
  brains = new BrainStore(path.join(root, 'brains.json'));
  await brains.load();
  await brains.add(
    BrainSchema.parse({
      id: 'a',
      name: 'Acme',
      connectionId: 'c',
      project: 'p',
      path: a,
      createdAt: '2026-11-13T09:00:00.000Z',
      sharing: {
        home: 'company',
        remoteUrl: server,
        repositoryId: 'r',
        homeOrganizationUrl: 'https://dev.azure.com/o',
        homeProject: 'p',
        joinedAt: '2026-11-13T09:00:00.000Z',
        lastPullAt: null,
        lastPushAt: null,
        status: 'ok',
        heldFile: null,
      },
    }),
  );
  fake = fakeRunner();
  changed = [];
  offs = [];
});

afterEach(async () => {
  offs.forEach((off) => off());
  await fs.rm(root, { recursive: true, force: true });
});

describe('BrainSync', () => {
  it('pushes a commit to the server within the debounce', async () => {
    const s = sync();
    offs.push(onBrainGitIdle((dir) => s.afterGit(dir)));
    await withBrainGit(a, async () => {
      await write(a, 'sources/n.md', 'a note\n');
      await commit(a, 'Brain: add source n.md');
    });
    const local = await head(a);
    await vi.waitFor(async () => expect(await serverHead()).toBe(local), {
      timeout: 3000,
    });
    await vi.waitFor(() => expect(sharing()?.lastPushAt).not.toBeNull());
    expect(sharing()?.status).toBe('ok');
    expect(changed).toContain('a');
  });

  it('merges and pushes again when the server rejects the push', async () => {
    await write(b, 'sources/b.md', 'from B\n');
    await commit(b, 'Brain: add source b.md');
    await pushB();
    await write(a, 'sources/a.md', 'from A\n');
    await commit(a, 'Brain: add source a.md');
    await sync().push('a');
    expect(await serverHead()).toBe(await head(a));
    expect(await exists(a, 'sources/b.md')).toBe(true);
    const parents = (await git.run(a, ['log', '-1', '--format=%P']))
      .trim()
      .split(' ');
    expect(parents).toHaveLength(2);
    expect(sharing()?.status).toBe('ok');
    expect(sharing()?.lastPullAt).not.toBeNull();
  });

  it('queues a clashing capture again at the front, with one replay', async () => {
    fake.ran('capture', 'sources/a.md', 0);
    await write(a, 'wiki/x.md', PAGE('TWO by A'));
    await commit(a, 'Brain: capture sources/a.md');
    await write(b, 'wiki/x.md', PAGE('TWO by B'));
    await commit(b, 'Brain: capture sources/b.md');
    await pushB();
    await sync().push('a');
    expect(fake.queued).toEqual([
      ['capture', 'sources/a.md', { front: true, replays: 1 }],
    ]);
    expect(await serverHead()).toBe(await head(a));
  });

  it('queues a clashing write again by its target', async () => {
    await write(a, 'reads/r.md', 'A\n');
    await commit(a, 'Brain: write reads/r.md');
    await write(b, 'reads/r.md', 'B\n');
    await commit(b, 'Brain: write reads/r.md');
    await pushB();
    await sync().push('a');
    expect(fake.queued).toEqual([
      ['write', null, { front: true, target: 'reads/r.md', replays: 1 }],
    ]);
  });

  it('fails the job on its second clash instead of running it again', async () => {
    const job = fake.ran('capture', 'sources/a.md', 1);
    await write(a, 'wiki/x.md', PAGE('TWO by A'));
    await commit(a, 'Brain: capture sources/a.md');
    await write(b, 'wiki/x.md', PAGE('TWO by B'));
    await commit(b, 'Brain: capture sources/b.md');
    await pushB();
    await sync().push('a');
    expect(fake.queued).toEqual([]);
    expect(fake.failed).toEqual([[job.id, RAN_AGAIN]]);
    expect(RAN_AGAIN).toBe(
      'Ran again: a colleague changed the brain at the same time',
    );
  });

  it('holds a push with a secret; a scrub folds the unsent commits so the secret never reaches the server', async () => {
    const before = await serverHead();
    await write(a, 'sources/s.md', `token ${TOKEN}\n`);
    await commit(a, 'Brain: add source s.md');
    const secret = await head(a);
    await writeState(a, (st) => ({ ...st, lastSyncCommit: secret }));
    await write(
      a,
      'brain/reads.json',
      JSON.stringify({
        reads: { 'reads/r.md': { at: 'x', commit: secret, pages: {} } },
      }),
    );
    await commit(a, 'Brain: sync');
    await sync().push('a');
    expect(await serverHead()).toBe(before);
    expect(sharing()).toMatchObject({
      status: 'held',
      heldFile: 'sources/s.md',
    });
    await scrubBrain(git, a, TOKEN);
    // The scrub's commit takes the line out, but the first commit still adds it: still held.
    await sync().push('a');
    expect(await serverHead()).toBe(before);
    expect(sharing()?.status).toBe('held');
    expect(await sync().squashUnsent('a')).toBe(true);
    const subjects = (
      await git.run(a, ['log', '--format=%s', `${before}..HEAD`])
    )
      .trim()
      .split('\n');
    expect(subjects).toEqual([
      'Brain: records moved to the changes since the last send',
      SQUASH_MESSAGE,
    ]);
    const squash = (await git.run(a, ['rev-parse', 'HEAD~1'])).trim();
    expect((await readState(a)).state?.lastSyncCommit).toBe(squash);
    const reads = JSON.parse(
      await fs.readFile(path.join(a, 'brain', 'reads.json'), 'utf8'),
    ) as { reads: Record<string, { commit: string }> };
    expect(reads.reads['reads/r.md'].commit).toBe(squash);
    expect(await git.run(a, ['status', '--porcelain'])).toBe('');
    await sync().push('a');
    expect(await serverHead()).toBe(await head(a));
    expect(sharing()).toMatchObject({ status: 'ok', heldFile: null });
    expect(await serverLog()).not.toContain(TOKEN);
  });

  it('scans a file whose name git quotes', async () => {
    const before = await serverHead();
    await write(a, 'sources/a"b.md', `token ${TOKEN}\n`);
    await commit(a, 'Brain: add source a"b.md');
    await sync().push('a');
    expect(await serverHead()).toBe(before);
    expect(sharing()).toMatchObject({
      status: 'held',
      heldFile: 'sources/a"b.md',
    });
    expect(unquoteGitPath('"b/a\\"b\\\\c\\tq\\303\\251.md"')).toBe(
      'b/a"b\\c\tq\u00e9.md',
    );
  });

  it('pushes the commit it scanned, not one made while it scanned', async () => {
    class Racing extends GitClient {
      raced = false;
      override async run(
        cwd: string,
        args: string[],
        opts?: { timeoutMs?: number; env?: Record<string, string> },
      ): Promise<string> {
        const out = await super.run(cwd, args, opts);
        if (!this.raced && args.includes('log') && args.includes('-p')) {
          this.raced = true;
          await write(a, 'sources/late.md', `late ${TOKEN}\n`);
          await super.run(a, ['add', '-A']);
          await super.run(a, [
            'commit',
            '-q',
            '-m',
            'Brain: add source late.md',
          ]);
        }
        return out;
      }
    }
    await write(a, 'sources/n.md', 'a note\n');
    await commit(a, 'Brain: add source n.md');
    const scanned = await head(a);
    await sync({ git: new Racing() }).push('a');
    expect(await serverHead()).toBe(scanned);
    expect(await head(a)).not.toBe(scanned);
    expect(await serverLog()).not.toContain(TOKEN);
  });

  it('skips a pull while a job of its runner runs, even past the stale lock hour', async () => {
    await write(b, 'sources/b.md', 'from B\n');
    await commit(b, 'Brain: add source b.md');
    await pushB();
    const before = await head(a);
    fake.state.busy = true;
    await sync().pull('a');
    expect(await head(a)).toBe(before);
    expect(await exists(a, 'brain/lock')).toBe(false);
    fake.state.busy = false;
    await sync().pull('a');
    expect(await exists(a, 'sources/b.md')).toBe(true);
  });

  it('commits outside edits before a pull of its own, then merges', async () => {
    await write(b, 'sources/b.md', 'from B\n');
    await commit(b, 'Brain: add source b.md');
    await pushB();
    await write(a, 'wiki/x.md', PAGE('TWO by hand'));
    await sync().pull('a');
    const subjects = (await git.run(a, ['log', '--format=%s', '-3']))
      .trim()
      .split('\n');
    expect(subjects).toContain(OUTSIDE_EDIT_MESSAGE);
    expect(await exists(a, 'sources/b.md')).toBe(true);
    expect(await git.run(a, ['status', '--porcelain'])).toBe('');
    expect(sharing()?.lastPullAt).not.toBeNull();
  });

  it('skips a pull while a job holds the lock, and pulls when the job says it holds it', async () => {
    await write(b, 'sources/b.md', 'from B\n');
    await commit(b, 'Brain: add source b.md');
    await pushB();
    const before = await head(a);
    expect(await acquireLock(a)).toBe(true);
    try {
      await sync().pull('a');
      expect(await head(a)).toBe(before);
      expect(await exists(a, 'sources/b.md')).toBe(false);
      expect(await git.run(a, ['status', '--porcelain'])).toBe('');
      expect(sharing()?.lastPullAt).toBeNull();
      await sync().pull('a', { lockHeld: true });
      expect(await exists(a, 'sources/b.md')).toBe(true);
    } finally {
      await releaseLock(a);
    }
  });

  it('keeps commits while the server is away, then merges once and queues only the clashing job', async () => {
    await write(b, 'wiki/x.md', PAGE('TWO by B'));
    await commit(b, 'Brain: capture sources/b.md');
    await pushB();
    const away = `${server}-away`;
    await fs.rename(server, away);
    await write(a, 'sources/n.md', 'a note\n');
    await commit(a, 'Brain: add source n.md');
    await write(a, 'wiki/x.md', PAGE('TWO by A'));
    await commit(a, 'Brain: capture sources/n.md');
    await write(a, 'sources/m.md', 'another\n');
    await commit(a, 'Brain: add source m.md');
    await write(a, 'reads/r.md', 'a read\n');
    await commit(a, 'Brain: write reads/r.md');
    const local = await head(a);
    const s = sync();
    await s.push('a');
    expect(sharing()?.status).toBe('unreachable');
    expect(await head(a)).toBe(local);
    await fs.rename(away, server);
    await s.push('a');
    const merges = (
      await git.run(a, ['rev-list', '--merges', `${local}..HEAD`])
    ).trim();
    expect(merges.split('\n')).toHaveLength(1);
    expect(fake.queued).toEqual([
      ['capture', 'sources/n.md', { front: true, replays: 1 }],
    ]);
    expect(await serverHead()).toBe(await head(a));
    expect(sharing()?.status).toBe('ok');
  });

  it('says unauthorized when the server refuses the sign-in', async () => {
    class NoSignIn extends GitClient {
      override async push(): Promise<void> {
        throw new GitAuthError('denied', 'Authentication failed', {
          host: 'dev.azure.com',
          connectionId: null,
          path: a,
        });
      }
    }
    await write(a, 'sources/n.md', 'a note\n');
    await commit(a, 'Brain: add source n.md');
    await sync({ git: new NoSignIn() }).push('a');
    expect(sharing()?.status).toBe('unauthorized');
  });

  it("the keeper captures a colleague's source uncaptured for over an hour, not a newer one", async () => {
    const now = new Date('2026-11-13T12:00:00Z');
    const ago = (min: number) =>
      new Date(now.getTime() - min * 60_000).toISOString();
    await write(b, 'sources/old.md', 'old\n');
    await commit(b, 'Brain: add source old.md', {
      GIT_COMMITTER_DATE: ago(61),
    });
    await write(b, 'sources/new.md', 'new\n');
    await commit(b, 'Brain: add source new.md', {
      GIT_COMMITTER_DATE: ago(59),
    });
    await write(b, 'sources/wiki/page.md', 'mirror\n');
    await commit(b, 'Brain: refresh wiki mirror (+1 ~0 -0)', {
      GIT_COMMITTER_DATE: ago(120),
    });
    await pushB();
    await sync({ installId: 'someone-else', now: () => now }).pull('a');
    expect(fake.queued).toEqual([]);
    const keeper = sync({ installId: 'keeper-1', now: () => now });
    await keeper.pull('a');
    expect(fake.queued).toEqual([
      ['capture', 'sources/old.md', { background: true }],
    ]);
    await keeper.pull('a');
    expect(fake.queued).toHaveLength(1);
  });
});
