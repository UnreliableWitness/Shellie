import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionDigest } from '../brain/sessionDigest';
import type { TurnAt } from '../sessions/claudeTranscript';
import {
  MAX_DREAM_TASKS,
  pickMaterial,
  writeMaterial,
  type TaskSessions,
} from './material';

const dev = (at: number | null, text = 'do it'): TurnAt => ({
  who: 'Developer',
  text,
  at,
});
const agent = (at: number | null): TurnAt => ({
  who: 'Claude',
  text: 'done',
  at,
});
const task = (id: string, sessions: TurnAt[][]): TaskSessions => ({
  taskId: id,
  label: `Label ${id}`,
  workItemId: 42,
  createdAt: '2026-11-01T10:00:00.000Z',
  agents: ['claude'],
  sessions,
});

describe('pickMaterial', () => {
  it('leaves out a task whose last developer turn is at or before its mark', () => {
    const m = pickMaterial([task('a', [[dev(100)]])], { a: 100 });
    expect(m.tasks).toEqual([]);
  });

  it('takes a task with all its sessions and newSince = the mark', () => {
    const t = task('a', [[dev(50)], [dev(200)]]);
    const m = pickMaterial([t], { a: 100 });
    expect(m.tasks).toHaveLength(1);
    expect(m.tasks[0].sessions).toHaveLength(2);
    expect(m.tasks[0].newSince).toBe(100);
    expect(m.marks).toEqual({ a: 200 });
  });

  it('gives a never covered task newSince null', () => {
    const m = pickMaterial([task('a', [[dev(5)]])], {});
    expect(m.tasks[0].newSince).toBeNull();
  });

  it('counts a null time as 0', () => {
    expect(pickMaterial([task('a', [[dev(null)]])], { a: 0 }).tasks).toEqual(
      [],
    );
    expect(pickMaterial([task('a', [[dev(null)]])], {}).tasks).toHaveLength(1);
  });

  it('never takes a task with only agent turns', () => {
    expect(pickMaterial([task('a', [[agent(900)]])], {}).tasks).toEqual([]);
  });

  it('keeps the 20 tasks with the latest turns, newest first', () => {
    const all = Array.from({ length: 25 }, (_, i) =>
      task(`t${i}`, [[dev(1000 + i)]]),
    );
    const m = pickMaterial(all, {});
    expect(MAX_DREAM_TASKS).toBe(20);
    expect(m.tasks).toHaveLength(20);
    expect(m.tasks[0].taskId).toBe('t24');
    expect(m.tasks.map((t) => t.taskId)).not.toContain('t4');
    expect(Object.keys(m.marks)).toHaveLength(20);
    expect(m.marks.t24).toBe(1024);
  });
});

describe('writeMaterial', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'material-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const memory = { sightings: [], rejections: [] };

  it('writes a digest per task and an index', async () => {
    const t = task('a', [[dev(1000, 'hello'), agent(2000)]]);
    const m = pickMaterial(
      [t, { ...task('b', [[dev(3000)]]), workItemId: null }],
      { a: 500 },
    );
    const files = await writeMaterial(dir, m, memory);
    expect(files).toContain('index.md');
    const body = fs.readFileSync(path.join(dir, 'tasks', 'a.md'), 'utf8');
    expect(body).toBe(sessionDigest(t.label, t.sessions));
    const index = fs.readFileSync(path.join(dir, 'index.md'), 'utf8');
    expect(index).toContain('Label a');
    expect(index).toContain('42');
    expect(index).toContain('2026-11-01');
    expect(index).toContain('claude');
    expect(index).toContain(`new since ${new Date(500).toISOString()}`);
    expect(index).toContain('not seen before');
    expect(index).not.toContain('## Seen once before');
    expect(index).not.toContain('## Rejected before');
  });

  it('lists sightings and rejections when there are some', async () => {
    const m = pickMaterial([task('a', [[dev(1)]])], {});
    await writeMaterial(dir, m, {
      sightings: [
        { at: '2026-11-02', note: 'seen note', taskId: 'a', quote: 'q' },
      ],
      rejections: [{ at: '2026-11-03', title: 'No tabs', why: 'because' }],
    });
    const index = fs.readFileSync(path.join(dir, 'index.md'), 'utf8');
    expect(index).toContain('## Seen once before');
    expect(index).toContain('seen note');
    expect(index).toContain('## Rejected before');
    expect(index).toContain('No tabs');
  });

  it('tells the model the newest 30 rejections only', async () => {
    const m = pickMaterial([task('a', [[dev(1)]])], {});
    await writeMaterial(dir, m, {
      sightings: [],
      rejections: Array.from({ length: 40 }, (_, i) => ({
        at: '2026-11-03',
        title: `Rejected ${i}`,
        why: 'because',
      })),
    });
    const index = fs.readFileSync(path.join(dir, 'index.md'), 'utf8');
    expect(index).not.toContain('Rejected 9:');
    expect(index).toContain('Rejected 10:');
    expect(index).toContain('Rejected 39:');
    expect(index.match(/Rejected \d+:/g)).toHaveLength(30);
  });

  it('makes file names safe and distinct', async () => {
    const m = pickMaterial(
      [
        task('a/b', [[dev(1)]]),
        task('a_b', [[dev(2)]]),
        task('..', [[dev(3)]]),
      ],
      {},
    );
    const files = await writeMaterial(dir, m, memory);
    const names = files.filter((f) => f !== 'index.md');
    expect(new Set(names).size).toBe(3);
    for (const n of names) expect(n).toMatch(/^tasks\/[A-Za-z0-9_-]+\.md$/);
    expect(fs.readdirSync(path.join(dir, 'tasks'))).toHaveLength(3);
    const index = fs.readFileSync(path.join(dir, 'index.md'), 'utf8');
    for (const n of names) expect(index).toContain(n);
  });

  it('keeps names distinct on a case-insensitive file system', async () => {
    const m = pickMaterial([task('A', [[dev(1)]]), task('a', [[dev(2)]])], {});
    const files = await writeMaterial(dir, m, memory);
    const names = files.filter((f) => f !== 'index.md');
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(2);
    expect(fs.readdirSync(path.join(dir, 'tasks'))).toHaveLength(2);
  });

  it('does not use a Windows device name as a file name', async () => {
    const m = pickMaterial([task('con', [[dev(1)]])], {});
    const files = await writeMaterial(dir, m, memory);
    const name = path.basename(files[1], '.md');
    expect(name.toLowerCase()).not.toBe('con');
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
