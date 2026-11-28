import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASK_LEFT_BY_QUIT,
  ASK_THREADS_MAX,
  type AskExchange,
  type AskThread,
} from '../../shared/brainAsk';
import { AskThreadStore } from './askThreads';

let dir: string;
let file: string;
let brains: string[];
const store = () => new AskThreadStore(file, () => brains);

const exchange = (over: Partial<AskExchange> = {}): AskExchange => ({
  id: 'e1',
  question: 'Why?',
  status: 'done',
  startedAt: 1000,
  answer: {
    sessionId: 's1',
    answer: 'Because.',
    durationMs: 10,
    costEur: null,
    changed: false,
  },
  error: null,
  refused: null,
  ...over,
});
const thread = (id: string, over: Partial<AskThread> = {}): AskThread => ({
  id,
  brainId: 'b1',
  taskId: null,
  startedAt: 1000,
  current: false,
  exchanges: [exchange()],
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ask-threads-'));
  file = path.join(dir, 'brain-asks.json');
  brains = ['b1', 'b2'];
});

describe('AskThreadStore', () => {
  it('gives back what was saved, after a restart too', async () => {
    const a = store();
    await a.load();
    expect(a.list()).toEqual([]);
    await a.save([thread('t1', { taskId: 'task1', current: true })]);
    const b = store();
    await b.load();
    expect(b.list()).toEqual([
      thread('t1', { taskId: 'task1', current: true }),
    ]);
  });

  it('keeps the newest fifty threads of a brain, the current ones first', async () => {
    const many = Array.from({ length: ASK_THREADS_MAX + 5 }, (_, i) =>
      thread(`t${i}`, { exchanges: [exchange({ startedAt: 1000 + i })] }),
    );
    const old = thread('old-current', {
      current: true,
      taskId: 'task1',
      exchanges: [exchange({ startedAt: 1 })],
    });
    const other = thread('other', { brainId: 'b2' });
    const a = store();
    await a.load();
    await a.save([...many, old, other]);
    const kept = a.list();
    expect(kept.filter((t) => t.brainId === 'b1')).toHaveLength(
      ASK_THREADS_MAX,
    );
    expect(kept.map((t) => t.id)).toContain('old-current');
    expect(kept.map((t) => t.id)).toContain('other');
    // The oldest that are not current went.
    for (const gone of ['t0', 't1', 't2', 't3', 't4', 't5'])
      expect(kept.map((t) => t.id)).not.toContain(gone);
    expect(kept.map((t) => t.id)).toContain('t6');
  });

  it('drops the threads of a brain that is no longer there, and empty threads', async () => {
    const a = store();
    await a.load();
    brains = ['b1'];
    await a.save([
      thread('t1'),
      thread('t2', { brainId: 'b2' }),
      thread('t3', { exchanges: [] }),
    ]);
    expect(a.list().map((t) => t.id)).toEqual(['t1']);
  });

  it('loads a question that was being answered when Shellie closed as one that could not finish', async () => {
    const a = store();
    await a.load();
    await a.save([
      thread('t1', {
        exchanges: [
          exchange(),
          exchange({ id: 'e2', status: 'running', answer: null }),
        ],
      }),
    ]);
    const b = store();
    await b.load();
    expect(b.list()[0].exchanges[1]).toMatchObject({
      status: 'failed',
      error: ASK_LEFT_BY_QUIT,
      answer: null,
    });
    expect(b.list()[0].exchanges[0].status).toBe('done');
  });

  it('starts empty on a file it cannot read, and keeps that file aside', async () => {
    writeFileSync(file, '{ not json');
    const a = store();
    await a.load();
    expect(a.list()).toEqual([]);
    expect(readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });
});
