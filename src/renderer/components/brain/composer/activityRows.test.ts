import { describe, expect, it } from 'vitest';
import type { BrainSourceRow } from '../../../../shared/brain';
import { brainJob } from '../../../test-helpers/brainFixture';
import { activityRows } from './activityRows';

const src = (path: string, captured = false): BrainSourceRow => ({
  path,
  type: 'doc',
  ingestedAt: '2026-11-02T10:00:00.000Z',
  captured,
  original: null,
  contents: null,
  note: null,
});
const at = (h: number) => `2026-11-02T${String(h).padStart(2, '0')}:00:00.000Z`;

describe('activityRows', () => {
  it('a capture running for a new source is one running row', () => {
    const job = brainJob({
      id: 'c',
      source: 'sources/a.md',
      status: 'running',
      error: null,
    });
    const rows = activityRows([job], [src('sources/a.md')], null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      group: 'running',
      source: 'sources/a.md',
      job,
    });
  });

  it('a failed capture of a waiting source needs you, once', () => {
    const job = brainJob({ id: 'f', source: 'sources/a.md', status: 'failed' });
    const rows = activityRows([job], [src('sources/a.md')], null);
    expect(rows).toEqual([
      expect.objectContaining({ group: 'needs', source: 'sources/a.md', job }),
    ]);
  });

  it('a file put in by hand needs you, with no job', () => {
    const rows = activityRows(
      [],
      [
        src('sources/hand.md'),
        src('sources/wiki/Home.md'),
        src('sources/c.md', true),
      ],
      null,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        group: 'needs',
        source: 'sources/hand.md',
        job: null,
      }),
    ]);
    expect(rows[0].reason?.text).toBe('not captured yet');
  });

  it("a source's newest job stands for it", () => {
    const done = brainJob({
      id: 'c',
      source: 'sources/a.md',
      status: 'done',
      error: null,
      startedAt: at(9),
    });
    const pics = brainJob({
      id: 'p',
      kind: 'pictures',
      source: 'sources/a.md',
      status: 'running',
      error: null,
      startedAt: at(10),
    });
    const rows = activityRows([done, pics], [src('sources/a.md', true)], null);
    expect(rows).toEqual([
      expect.objectContaining({ group: 'running', job: pics }),
    ]);
  });

  it('a job without a source is a row of its own', () => {
    const lint = brainJob({
      id: 'l',
      kind: 'lint',
      source: null,
      status: 'done',
      error: null,
    });
    expect(activityRows([lint], [], null)).toEqual([
      expect.objectContaining({ group: 'earlier', source: null, job: lint }),
    ]);
  });

  it('background jobs show while running or failed, not queued or done', () => {
    const bg = (status: 'queued' | 'running' | 'done' | 'failed') =>
      brainJob({
        id: status,
        kind: 'pictures',
        source: 'sources/x.md',
        background: true,
        status,
        error: null,
      });
    expect(activityRows([bg('queued')], [], null)).toEqual([]);
    expect(activityRows([bg('done')], [], null)).toEqual([]);
    expect(activityRows([bg('running')], [], null)[0].group).toBe('running');
    expect(activityRows([bg('failed')], [], null)[0].group).toBe('earlier');
  });

  it('orders running, then needs you, then earlier, each newest first', () => {
    const rows = activityRows(
      [
        brainJob({
          id: 'e1',
          kind: 'lint',
          source: null,
          status: 'done',
          error: null,
          startedAt: at(8),
        }),
        brainJob({
          id: 'e2',
          kind: 'digest',
          source: null,
          status: 'done',
          error: null,
          startedAt: at(11),
        }),
        brainJob({
          id: 'r',
          source: 'sources/r.md',
          status: 'queued',
          startedAt: null,
          endedAt: null,
          error: null,
        }),
      ],
      [src('sources/r.md'), src('sources/n.md')],
      'cap',
    );
    expect(rows.map((r) => r.key)).toEqual([
      'r',
      'source:sources/n.md',
      'e2',
      'e1',
    ]);
    expect(rows[0].reason?.text).toBe('paused: daily token cap');
  });
});
