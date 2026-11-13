import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrainSchema,
  isBookJob,
  type Brain,
  type BrainJob,
} from '../../shared/brain';
import { createBookHooks, MAX_BOOK_ATTEMPTS } from './bookPass';

const VALID = JSON.stringify({
  chapters: [{ title: 'T', summary: 's', intro: 'i', pages: [] }],
});

describe('isBookJob', () => {
  it('is a background sync, nothing else', () => {
    expect(isBookJob({ kind: 'sync', background: true })).toBe(true);
    expect(isBookJob({ kind: 'sync', background: false })).toBe(false);
    expect(isBookJob({ kind: 'pictures', background: true })).toBe(false);
    expect(isBookJob({ kind: 'capture', background: false })).toBe(false);
  });
});

describe('createBookHooks', () => {
  let dir: string;
  let stored: Brain;
  let queue: BrainJob[];
  let patches: number;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shellie-bookpass-'));
    await fs.mkdir(path.join(dir, 'wiki'));
    await fs.mkdir(path.join(dir, 'brain'));
    stored = BrainSchema.parse({
      id: 'b',
      name: 'B',
      connectionId: 'c',
      project: 'p',
      path: dir,
      createdAt: 't',
      templatesVersion: 8,
    });
    queue = [];
    patches = 0;
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  const job = (over: Partial<BrainJob>): BrainJob => ({
    id: `b:${queue.length}`,
    brainId: 'b',
    kind: 'sync',
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
  const page = () =>
    fs.writeFile(
      path.join(dir, 'wiki', 'account.md'),
      '---\ntitle: A\nsummary: s\n---\n# A\n',
    );
  const book = (text: string) =>
    fs.writeFile(path.join(dir, 'brain', 'book.json'), text);
  const hooks = () => {
    const enqueue = vi.fn(
      (
        _id: string,
        kind: BrainJob['kind'],
        _source?: string | null,
        opts?: { background?: boolean },
      ) => {
        const j = job({ kind, background: opts?.background ?? false });
        queue.push(j);
        return j;
      },
    );
    const h = createBookHooks({
      brains: {
        get: (id) => (id === 'b' ? stored : undefined),
        patch: async (_id, p) => {
          patches++;
          stored = { ...stored, ...p };
        },
      },
      runner: () => ({ enqueue, jobs: () => [...queue] }),
    });
    return { h, enqueue };
  };

  it('queues one background sync for a brain with pages and no valid book', async () => {
    await page();
    const { h, enqueue } = hooks();
    await h.bookPass('b');
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('b', 'sync', null, {
      background: true,
    });
    expect(h.passRunning('b')).toBe(true);
  });

  it('queues one for an unusable book file too', async () => {
    await page();
    await book('{ not json');
    const { h, enqueue } = hooks();
    await h.bookPass('b');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('queues nothing with a valid book, with no pages, or on old skills', async () => {
    const { h, enqueue } = hooks();
    await h.bookPass('b');
    await page();
    await book(VALID);
    await h.bookPass('b');
    await book('{}');
    stored = { ...stored, templatesVersion: 7 };
    await h.bookPass('b');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues nothing after two failed attempts', async () => {
    await page();
    stored = { ...stored, bookPass: { attempts: MAX_BOOK_ATTEMPTS } };
    const { h, enqueue } = hooks();
    await h.bookPass('b');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running', 'paused'] as const)(
    'queues nothing while a sync is %s',
    async (status) => {
      await page();
      queue.push(job({ background: false, status }));
      const { h, enqueue } = hooks();
      await h.bookPass('b');
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('a finished sync does not block it', async () => {
    await page();
    queue.push(job({ background: false, status: 'done' }));
    const { h, enqueue } = hooks();
    await h.bookPass('b');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('two calls at once, or one after the other while queued, queue one job', async () => {
    await page();
    const { h, enqueue } = hooks();
    await Promise.all([h.bookPass('b'), h.bookPass('b')]);
    await h.bookPass('b');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  describe('afterJob', () => {
    const settle = async (h: ReturnType<typeof hooks>['h']) => {
      await vi.waitFor(() => expect(h.passRunning('b')).toBe(false));
    };

    it.each(['done', 'failed'] as const)(
      'a %s book job with no valid book counts an attempt',
      async (status) => {
        await page();
        const { h } = hooks();
        h.afterJob(job({ status }));
        await settle(h);
        expect(stored.bookPass).toEqual({ attempts: 1 });
        h.afterJob(job({ status }));
        await settle(h);
        expect(stored.bookPass).toEqual({ attempts: 2 });
      },
    );

    it('a done job with a valid book leaves the count alone', async () => {
      await page();
      await book(VALID);
      const { h } = hooks();
      h.afterJob(job({ status: 'done' }));
      await settle(h);
      expect(stored.bookPass).toBeNull();
      expect(patches).toBe(0);
    });

    it('a normal sync, a capture or an unfinished job never counts', async () => {
      const { h } = hooks();
      h.afterJob(job({ background: false, status: 'done' }));
      h.afterJob(job({ kind: 'capture', background: false, status: 'failed' }));
      h.afterJob(job({ kind: 'pictures', status: 'failed' }));
      h.afterJob(job({ status: 'running' }));
      await settle(h);
      expect(patches).toBe(0);
    });

    it('no job is queued between the end of one and the saved count', async () => {
      await page();
      const { h, enqueue } = hooks();
      h.afterJob(job({ status: 'failed' }));
      await h.bookPass('b');
      expect(enqueue).not.toHaveBeenCalled();
      await settle(h);
      await h.bookPass('b');
      expect(enqueue).toHaveBeenCalledTimes(1);
    });
  });
});
