import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainSchema, type Brain, type BrainJob } from '../../shared/brain';
import { readRecord } from './reads';
import {
  createReadsHooks,
  MAX_READ_FAILURES,
  MAX_READS_A_DAY,
  READ_RETRY_DAYS,
} from './readsHooks';

const READ = [
  '---',
  'title: Order to invoice',
  'summary: s',
  'chapter: Orders',
  'pages:',
  '  - wiki/subject-orders.md',
  'written: 2026-11-09',
  '---',
  '',
  'An order is a promise.',
  '',
].join('\n');

describe('createReadsHooks', () => {
  let dir: string;
  let stored: Brain;
  let queue: BrainJob[];
  let patches: number;
  let tokens: number;
  let at: Date;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-readshooks-'));
    await fs.mkdir(path.join(dir, 'wiki'));
    await fs.mkdir(path.join(dir, 'brain'));
    await fs.mkdir(path.join(dir, 'reads'));
    await fs.writeFile(
      path.join(dir, 'wiki', 'subject-orders.md'),
      '---\ntitle: Orders\nsummary: s\n---\n# Orders\n\nAn order.\n',
    );
    await fs.writeFile(
      path.join(dir, 'brain', 'book.json'),
      JSON.stringify({
        chapters: [
          {
            title: 'Orders',
            summary: 's',
            intro: 'i',
            pages: ['wiki/subject-orders.md'],
          },
        ],
      }),
    );
    stored = BrainSchema.parse({
      id: 'b',
      name: 'B',
      connectionId: 'c',
      project: 'p',
      path: dir,
      createdAt: 't',
      templatesVersion: 10,
      options: { writeLongReads: true, dailyTokenCap: 1000 },
    });
    queue = [];
    patches = 0;
    tokens = 0;
    at = new Date(2026, 10, 11, 9);
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  const job = (over: Partial<BrainJob>): BrainJob => ({
    id: `b:${queue.length}`,
    brainId: 'b',
    kind: 'write',
    source: null,
    status: 'queued',
    startedAt: null,
    endedAt: null,
    sessionId: null,
    result: null,
    error: null,
    background: true,
    agent: 'claude',
    model: null,
    replays: 0,
    ...over,
  });
  const hooks = () => {
    const enqueue = vi.fn(
      (
        _id: string,
        kind: BrainJob['kind'],
        _source?: string | null,
        opts?: { background?: boolean; target?: string },
      ) => {
        const j = job({
          kind,
          background: opts?.background ?? false,
          target: opts?.target,
        });
        queue.push(j);
        return j;
      },
    );
    const git = {
      run: vi.fn(async (_dir: string, args: string[]) =>
        args.includes('rev-parse')
          ? 'abc123\n'
          : args.includes('status')
            ? '?? reads/order-to-invoice.md\0'
            : '',
      ),
    };
    const h = createReadsHooks({
      brains: {
        get: (id) => (id === 'b' ? stored : undefined),
        patch: async (_id, p) => {
          patches++;
          stored = { ...stored, ...p };
        },
      },
      runner: () => ({ enqueue, jobs: () => [...queue] }),
      git,
      tokensToday: () => tokens,
      now: () => at,
    });
    return { h, enqueue, git };
  };
  const settle = async (h: ReturnType<typeof hooks>['h']) => {
    await vi.waitFor(() => expect(h.passRunning('b')).toBe(false));
  };
  const finish = (status: 'done' | 'failed') => {
    for (const j of queue) if (j.status === 'queued') j.status = status;
  };

  describe('readsPass', () => {
    it('queues one background write for the first chapter without a long read', async () => {
      const { h, enqueue } = hooks();
      await h.readsPass('b');
      expect(enqueue).toHaveBeenCalledExactlyOnceWith('b', 'write', null, {
        background: true,
        target: 'chapter:Orders',
      });
      expect(h.passRunning('b')).toBe(true);
      finish('done');
      await settle(h);
      expect(stored.readsPass).toEqual({
        failures: {},
        day: '2026-11-11',
        started: 1,
      });
    });

    it('queues nothing when the switch is off, the skills are old or the brain is archived', async () => {
      const { h, enqueue } = hooks();
      const on = stored;
      stored = { ...on, options: { ...on.options, writeLongReads: false } };
      await h.readsPass('b');
      stored = { ...on, templatesVersion: 9 };
      await h.readsPass('b');
      stored = { ...on, archived: true };
      await h.readsPass('b');
      await h.readsPass('gone');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it.each(['queued', 'running', 'paused'] as const)(
      'queues nothing while any job is %s',
      async (status) => {
        queue.push(job({ kind: 'capture', background: false, status }));
        const { h, enqueue } = hooks();
        await h.readsPass('b');
        expect(enqueue).not.toHaveBeenCalled();
      },
    );

    it('queues nothing from half of the token cap on', async () => {
      const { h, enqueue } = hooks();
      tokens = 500;
      await h.readsPass('b');
      expect(enqueue).not.toHaveBeenCalled();
      tokens = 499;
      await h.readsPass('b');
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('stops for the day after its writes of the day, and starts again the next', async () => {
      stored = {
        ...stored,
        readsPass: {
          failures: {},
          day: '2026-11-11',
          started: MAX_READS_A_DAY,
        },
      };
      const { h, enqueue } = hooks();
      await h.readsPass('b');
      expect(enqueue).not.toHaveBeenCalled();
      at = new Date(2026, 10, 12, 9);
      await h.readsPass('b');
      expect(enqueue).toHaveBeenCalledTimes(1);
      finish('done');
      await settle(h);
      expect(stored.readsPass).toMatchObject({ day: '2026-11-12', started: 1 });
    });

    it('passes over a target that failed twice, and queues nothing when all is written', async () => {
      stored = {
        ...stored,
        readsPass: {
          failures: {
            'chapter:Orders': { count: MAX_READ_FAILURES, day: '2026-11-10' },
          },
          day: null,
          started: 0,
        },
      };
      const { h, enqueue } = hooks();
      await h.readsPass('b');
      // The day before it may be tried again.
      at = new Date(2026, 10, 10 + READ_RETRY_DAYS - 1, 9);
      await h.readsPass('b');
      stored = { ...stored, readsPass: null };
      at = new Date(2026, 10, 11, 9);
      await fs.writeFile(path.join(dir, 'reads', 'order-to-invoice.md'), READ);
      await h.readsPass('b');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('tries a target that failed twice again after a week, counting from one', async () => {
      stored = {
        ...stored,
        readsPass: {
          failures: {
            'chapter:Orders': { count: MAX_READ_FAILURES, day: '2026-11-04' },
          },
          day: null,
          started: 0,
        },
      };
      const { h, enqueue } = hooks();
      await h.readsPass('b');
      expect(enqueue).toHaveBeenCalledExactlyOnceWith('b', 'write', null, {
        background: true,
        target: 'chapter:Orders',
      });
      finish('failed');
      await settle(h);
      h.afterJob(queue[0]);
      await settle(h);
      expect(stored.readsPass?.failures).toEqual({
        'chapter:Orders': { count: 1, day: '2026-11-11' },
      });
    });

    it('two calls at once, or one after the other while queued, queue one job', async () => {
      const { h, enqueue } = hooks();
      await Promise.all([h.readsPass('b'), h.readsPass('b')]);
      await h.readsPass('b');
      expect(enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('promptFor', () => {
    it('hands a write job its target, and leaves other kinds alone', async () => {
      const { h } = hooks();
      expect(await h.promptFor(job({ target: 'chapter:Orders' }))).toBe(
        '/write chapter Orders',
      );
      expect(await h.promptFor(job({ target: 'topic:Credit notes' }))).toBe(
        '/write topic Credit notes',
      );
      expect(await h.promptFor(job({ kind: 'sync' }))).toBeUndefined();
    });

    it('throws for a target that does not hold, so the job fails', async () => {
      const { h } = hooks();
      await expect(
        h.promptFor(job({ target: 'chapter:Nope' })),
      ).rejects.toThrow('The book has no such chapter');
      await expect(h.promptFor(job({}))).rejects.toThrow();
    });
  });

  describe('stamp', () => {
    it('records what the long read of a write job was written from', async () => {
      const { h } = hooks();
      await fs.writeFile(path.join(dir, 'reads', 'order-to-invoice.md'), READ);
      await h.stamp(job({ target: 'chapter:Orders' }));
      const rec = (await readRecord(dir)).reads['reads/order-to-invoice.md'];
      expect(rec).toMatchObject({ at: at.toISOString(), commit: 'abc123' });
      expect(Object.keys(rec.pages)).toEqual(['wiki/subject-orders.md']);
    });

    it('does nothing for another kind', async () => {
      const { h, git } = hooks();
      await h.stamp(job({ kind: 'sync' }));
      expect(git.run).not.toHaveBeenCalled();
    });
  });

  describe('afterJob', () => {
    it.each(['done', 'failed'] as const)(
      'an automatic write that ended %s without its long read counts a failure',
      async (status) => {
        const { h } = hooks();
        h.afterJob(job({ status, target: 'chapter:Orders' }));
        await settle(h);
        h.afterJob(job({ status, target: 'chapter:Orders' }));
        await settle(h);
        expect(stored.readsPass?.failures).toEqual({
          'chapter:Orders': { count: 2, day: '2026-11-11' },
        });
      },
    );

    it('a write that left its long read counts nothing', async () => {
      await fs.writeFile(path.join(dir, 'reads', 'order-to-invoice.md'), READ);
      const { h } = hooks();
      h.afterJob(job({ status: 'done', target: 'chapter:Orders' }));
      await settle(h);
      expect(patches).toBe(0);
    });

    it('a write that worked, by hand too, forgets the earlier failures', async () => {
      await fs.writeFile(path.join(dir, 'reads', 'order-to-invoice.md'), READ);
      stored = {
        ...stored,
        readsPass: {
          failures: {
            'chapter:Orders': { count: 2, day: '2026-11-10' },
            'chapter:Other': { count: 1, day: '2026-11-10' },
          },
          day: null,
          started: 0,
        },
      };
      const { h } = hooks();
      h.afterJob(
        job({ status: 'done', background: false, target: 'chapter:Orders' }),
      );
      await settle(h);
      expect(stored.readsPass?.failures).toEqual({
        'chapter:Other': { count: 1, day: '2026-11-10' },
      });
    });

    it('a write by hand that failed, another kind or an unfinished job never counts', async () => {
      const { h } = hooks();
      h.afterJob(
        job({ status: 'failed', background: false, target: 'chapter:Orders' }),
      );
      h.afterJob(job({ kind: 'sync', status: 'failed' }));
      h.afterJob(job({ status: 'running', target: 'chapter:Orders' }));
      await settle(h);
      expect(patches).toBe(0);
    });
  });
});
