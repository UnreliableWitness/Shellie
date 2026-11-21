import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DreamJournalEntry } from '../../shared/dreams';
import { DreamStore } from './DreamStore';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-20T10:00:00Z');

async function make(
  now = () => T0,
  dir = mkdtempSync(path.join(tmpdir(), 'dreams-')),
) {
  const s = new DreamStore(dir, now);
  await s.load();
  return { s, dir };
}

const entry = (n: number): DreamJournalEntry => ({
  dreamId: `d${n}`,
  repoId: 'r',
  at: new Date(T0 + n).toISOString(),
  model: 'm',
  tokens: 1,
  outcome: 'nothing',
  reason: null,
  proposals: 0,
  removedByCheck: 0,
  closed: null,
});

describe('DreamStore', () => {
  it('gives an empty state for an unknown repo', async () => {
    const { s } = await make();
    expect(s.repo('x')).toEqual({
      covered: {},
      sightings: [],
      rejections: [],
      failures: 0,
      lastFailureAt: null,
      lastFailure: null,
      lastDreamAt: null,
      lastOutcome: null,
      result: null,
      opened: null,
    });
  });

  it('loads a dreams.json written before `opened` and `repoName` existed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dreams-'));
    const { opened: _none, ...oldRepo } = (await make()).s.repo('r');
    const { repoName: _n, ...oldEntry } = entry(1);
    writeFileSync(
      path.join(dir, 'dreams.json'),
      JSON.stringify({
        version: 1,
        repos: { r: { ...oldRepo, failures: 2 } },
        journal: [oldEntry],
        switchedOff: null,
      }),
    );
    const { s } = await make(() => T0, dir);
    expect(s.repo('r')).toMatchObject({ failures: 2, opened: null });
    expect(s.journal()).toEqual([oldEntry]);
  });

  it('opens a result as a task in one write: the result goes, the branch is remembered until the task is named', async () => {
    const { s, dir } = await make();
    await s.log({ ...entry(1), dreamId: 'd1', outcome: 'proposed' });
    await s.closeJournal('r', 'd1', {
      as: 'task',
      kept: 2,
      dropped: 1,
      taskName: null,
    });
    const fn = vi.fn();
    s.onChange(fn);
    const opened = {
      dreamId: 'd1',
      branch: 'dream/d1',
      at: new Date(T0).toISOString(),
      kept: 2,
      titles: ['A', 'B'],
    };
    await s.openedAsTask('r', opened);
    expect(fn).toHaveBeenCalledTimes(1);
    const { s: again } = await make(() => T0, dir);
    expect(again.repo('r')).toMatchObject({ result: null, opened });
    await again.taskMade('r', 'd1', 'Rules from a dream');
    expect(again.repo('r').opened).toBeNull();
    expect(again.journal()[0].closed).toEqual({
      as: 'task',
      kept: 2,
      dropped: 1,
      taskName: 'Rules from a dream',
    });
    // Another dream's id changes nothing.
    await again.openedAsTask('r', opened);
    await again.taskMade('r', 'd9', 'x');
    expect(again.repo('r').opened).toEqual(opened);
    await again.setOpened('r', null);
    expect(again.repo('r').opened).toBeNull();
  });

  it('lists the repo ids it holds state for, and forgets one', async () => {
    const { s } = await make();
    await s.failed('a', 'x');
    await s.failed('b', 'x');
    expect(s.repoIds().sort()).toEqual(['a', 'b']);
    await s.forgetRepo('a');
    expect(s.repoIds()).toEqual(['b']);
  });

  it('counts failures, keeps the reason, and succeeded resets', async () => {
    const { s } = await make();
    await s.failed('r', 'a');
    await s.failed('r', 'b');
    expect(s.repo('r').failures).toBe(2);
    expect(s.repo('r').lastFailure).toBe('b');
    await s.succeeded('r', 'nothing');
    expect(s.repo('r').failures).toBe(0);
    expect(s.repo('r').lastOutcome).toBe('nothing');
  });

  it('drops sightings older than 90 days and keeps the new', async () => {
    let t = T0;
    const { s } = await make(() => t);
    const mk = (at: number, note: string) => ({
      at: new Date(at).toISOString(),
      note,
      taskId: 't',
      quote: 'q',
    });
    await s.addSightings('r', [mk(T0, 'old')]);
    t = T0 + 91 * DAY;
    await s.addSightings('r', [mk(t, 'new')]);
    expect(s.repo('r').sightings.map((x) => x.note)).toEqual(['new']);
  });

  it('drops sightings older than 90 days when it loads, too', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dreams-'));
    const { opened: _o, ...repo } = (await make()).s.repo('r');
    const at = (ms: number) => new Date(ms).toISOString();
    writeFileSync(
      path.join(dir, 'dreams.json'),
      JSON.stringify({
        version: 1,
        repos: {
          r: {
            ...repo,
            sightings: [
              { at: at(T0 - 91 * DAY), note: 'old', taskId: 't', quote: 'q' },
              { at: at(T0 - DAY), note: 'new', taskId: 't', quote: 'q' },
            ],
          },
        },
        journal: [],
      }),
    );
    const { s } = await make(() => T0, dir);
    expect(s.repo('r').sightings.map((x) => x.note)).toEqual(['new']);
  });

  it('keeps the newest 100 rejections of a repo', async () => {
    const { s } = await make();
    const p = (title: string) => ({
      id: title,
      kind: 'new-rule' as const,
      title,
      why: 'w',
      evidence: [],
      files: [],
      commit: 'c',
      dropped: false,
    });
    await s.reject(
      'r',
      Array.from({ length: 99 }, (_, i) => p(`t${i}`)),
    );
    await s.reject('r', [p('t99'), p('t100'), p('t101')]);
    const titles = s.repo('r').rejections.map((x) => x.title);
    expect(titles).toHaveLength(100);
    expect(titles[0]).toBe('t2');
    expect(titles.at(-1)).toBe('t101');
  });

  it('markCovered keeps the larger time per task', async () => {
    const { s } = await make();
    await s.markCovered('r', { a: 5, b: 9 });
    await s.markCovered('r', { a: 3, b: 12 });
    expect(s.repo('r').covered).toEqual({ a: 5, b: 12 });
  });

  it('loads a corrupt file as empty without throwing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dreams-'));
    writeFileSync(path.join(dir, 'dreams.json'), '{not json');
    const { s } = await make(() => T0, dir);
    expect(s.journal()).toEqual([]);
    expect(s.repo('r').failures).toBe(0);
  });

  it('loads an old-shaped file as empty', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dreams-'));
    writeFileSync(
      path.join(dir, 'dreams.json'),
      JSON.stringify({ version: 0, repos: 3 }),
    );
    const { s } = await make(() => T0, dir);
    expect(s.journal()).toEqual([]);
  });

  it('keeps the newest 100 journal entries, newest first', async () => {
    const { s } = await make();
    for (let i = 0; i < 101; i++) await s.log(entry(i));
    const j = s.journal();
    expect(j).toHaveLength(100);
    expect(j[0].dreamId).toBe('d100');
    expect(j[99].dreamId).toBe('d1');
  });

  it('closeJournal fills the right entry and ignores an unknown dream', async () => {
    const { s } = await make();
    await s.log(entry(1));
    await s.log(entry(2));
    const closed = { as: 'task' as const, kept: 2, dropped: 1, taskName: 'n' };
    await s.closeJournal('r', 'd1', closed);
    await s.closeJournal('r', 'nope', closed);
    expect(s.journal().find((e) => e.dreamId === 'd1')?.closed).toEqual(closed);
    expect(s.journal().find((e) => e.dreamId === 'd2')?.closed).toBeNull();
  });

  it('closeJournal tells two repos’ dreams of the same id apart', async () => {
    const { s } = await make();
    await s.log(entry(1));
    // Newer, another repo, the same per-repo id.
    await s.log({ ...entry(1), repoId: 'other' });
    const closed = {
      as: 'discarded' as const,
      kept: 0,
      dropped: 1,
      taskName: null,
    };
    await s.closeJournal('r', 'd1', closed);
    expect(s.journal().find((e) => e.repoId === 'r')?.closed).toEqual(closed);
    expect(s.journal().find((e) => e.repoId === 'other')?.closed).toBeNull();
  });

  it('sets the result, toggles dropped, rejects and forgets', async () => {
    const { s } = await make();
    const p = {
      id: 'p1',
      kind: 'new-rule' as const,
      title: 'T',
      why: 'W',
      evidence: [],
      files: [],
      commit: 'c',
      dropped: false,
    };
    await s.setResult('r', {
      id: 'd',
      repoId: 'r',
      branch: 'b',
      baseSha: 's',
      worktreePath: 'w',
      dataDir: 'x',
      at: 'a',
      model: 'm',
      tokens: 1,
      sessions: 1,
      proposals: [p],
      reverted: [],
      removedByCheck: 0,
    });
    await s.setDropped('r', 'p1', true);
    expect(s.repo('r').result?.proposals[0].dropped).toBe(true);
    await s.reject('r', [p]);
    expect(s.repo('r').rejections).toMatchObject([{ title: 'T', why: 'W' }]);
    await s.forgetRepo('r');
    expect(s.repo('r').result).toBeNull();
  });

  it('survives a new store on the same folder, and notifies on change', async () => {
    const { s, dir } = await make();
    const fn = vi.fn();
    s.onChange(fn);
    await s.failed('r', 'x');
    expect(fn).toHaveBeenCalledTimes(1);
    const { s: s2 } = await make(() => T0, dir);
    expect(s2.repo('r').failures).toBe(1);
  });

  it('keeps why dreaming switched itself off across a restart, until cleared', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dreams-'));
    // A file written before the field existed loads with none.
    writeFileSync(
      path.join(dir, 'dreams.json'),
      JSON.stringify({ version: 1, repos: {}, journal: [] }),
    );
    const { s } = await make(() => T0, dir);
    expect(s.switchedOff('p1')).toBeNull();
    const off = { answered: 'a/b', chosen: 'zai/glm-5', repoId: 'r' };
    await s.setSwitchedOff('p1', off);
    const { s: s2 } = await make(() => T0, dir);
    expect(s2.switchedOff('p1')).toEqual(off);
    // One project's record is no other project's.
    expect(s2.switchedOff('p2')).toBeNull();
    expect(s2.switchedOffProjects()).toEqual(['p1']);
    await s2.setSwitchedOff('p1', null);
    expect(s2.switchedOff('p1')).toBeNull();
  });

  it('moves the record of before dreams were per project to the projects it belongs to, once', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dreams-'));
    const old = { answered: 'a/b', chosen: 'zai/glm-5', repoId: 'r' };
    writeFileSync(
      path.join(dir, 'dreams.json'),
      JSON.stringify({ version: 1, repos: {}, journal: [], switchedOff: old }),
    );
    const { s } = await make(() => T0, dir);
    // Until it is moved it keeps every project off.
    expect(s.switchedOff('p9')).toEqual(old);
    const own = { answered: 'x/y', chosen: 'zai/glm-5', repoId: 'q' };
    await s.setSwitchedOff('p2', own);
    const asked = vi.fn(() => ['p1', 'p2']);
    await s.adoptLegacySwitchedOff(asked);
    expect(asked).toHaveBeenCalledWith(old);
    const { s: s2 } = await make(() => T0, dir);
    expect(s2.switchedOff('p1')).toEqual(old);
    expect(s2.switchedOff('p2')).toEqual(own);
    expect(s2.switchedOff('p9')).toBeNull();
    await s2.adoptLegacySwitchedOff(asked);
    expect(asked).toHaveBeenCalledTimes(1);
  });
});
