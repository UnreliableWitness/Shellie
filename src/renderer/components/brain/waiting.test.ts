import { describe, expect, it } from 'vitest';
import type { BrainSourceRow } from '../../../shared/brain';
import { brainJob } from '../../test-helpers/brainFixture';
import { badgeCount, waitReason, waitingSources } from './waiting';

const src = (path: string, captured = false): BrainSourceRow => ({
  path,
  type: 'note',
  ingestedAt: '2026-11-01T09:00:00.000Z',
  captured,
  original: null,
  contents: null,
  note: null,
});
const job = (status: Parameters<typeof brainJob>[0] = {}) =>
  brainJob({ source: 'sources/a.md', ...status });

describe('waitingSources', () => {
  it('keeps uncaptured sources outside the wiki mirror', () => {
    const out = waitingSources([
      src('sources/a.md'),
      src('sources/b.md', true),
      src('sources/wiki/Home.md'),
    ]);
    expect(out.map((s) => s.path)).toEqual(['sources/a.md']);
  });
});

describe('waitReason', () => {
  const reason = (status: string | null, paused: 'cap' | null = null) =>
    waitReason(
      'sources/a.md',
      status ? [job({ status: status as 'queued' })] : [],
      paused,
    );

  it('maps each job state', () => {
    expect(reason('queued')).toEqual({ kind: 'queued', text: 'queued' });
    expect(reason('running')).toEqual({ kind: 'running', text: 'capturing…' });
    expect(reason('paused')).toEqual({
      kind: 'paused',
      text: 'paused: daily token cap',
    });
    expect(reason('failed')).toEqual({
      kind: 'failed',
      text: 'claude exited 1',
    });
    expect(reason('done')).toEqual({ kind: 'none', text: 'not captured yet' });
  });

  it('says failed when the job has no error text', () => {
    expect(
      waitReason(
        'sources/a.md',
        [job({ status: 'failed', error: null })],
        null,
      ),
    ).toEqual({ kind: 'failed', text: 'failed' });
  });

  it('shows a queued job as paused while the cap holds the queue', () => {
    expect(reason('queued', 'cap')).toEqual({
      kind: 'paused',
      text: 'paused: daily token cap',
    });
  });

  it('says not captured yet without a job', () => {
    expect(reason(null)).toEqual({ kind: 'none', text: 'not captured yet' });
  });

  it('lets the newest capture job for the path decide, ignoring other jobs', () => {
    const jobs = [
      job({ id: '4', status: 'failed', source: 'sources/other.md' }),
      job({ id: '3', status: 'failed', kind: 'lint' }),
      job({ id: '2', status: 'running' }),
      job({ id: '1', status: 'failed' }),
    ];
    expect(waitReason('sources/a.md', jobs, null).kind).toBe('running');
  });

  it('follows a retry: an older failed job does not outrank a newer queued one', () => {
    const jobs = [
      job({ id: '2', status: 'queued' }),
      job({ id: '1', status: 'failed' }),
    ];
    expect(waitReason('sources/a.md', jobs, null).kind).toBe('queued');
  });
});

describe('badgeCount', () => {
  it('leaves out an answer whose settle has not run yet', () => {
    const sources = [src('sources/a.md'), src('sources/answer.md')];
    expect(badgeCount(sources, [], ['sources/answer.md'])).toBe(1);
  });

  it('counts waiting sources with no queued or running job', () => {
    const sources = [src('sources/a.md'), src('sources/b.md')];
    const jobs = [job({ status: 'running' })];
    expect(badgeCount(sources, jobs)).toBe(1);
  });

  it('does not count a retried source whose newest job is queued', () => {
    const jobs = [
      job({ id: '2', status: 'queued' }),
      job({ id: '1', status: 'failed' }),
    ];
    expect(badgeCount([src('sources/a.md')], jobs)).toBe(0);
  });

  it('does not count a queued job while the cap holds the queue', () => {
    const jobs = [job({ status: 'queued' })];
    expect(waitReason('sources/a.md', jobs, 'cap').text).toBe(
      'paused: daily token cap',
    );
    expect(badgeCount([src('sources/a.md')], jobs)).toBe(0);
  });

  it('does not count a source whose capture the cap paused', () => {
    expect(badgeCount([src('sources/a.md')], [job({ status: 'paused' })])).toBe(
      0,
    );
  });

  it('ignores a failed lint job', () => {
    const jobs = [job({ status: 'failed', kind: 'lint', source: null })];
    expect(badgeCount([src('sources/a.md')], jobs)).toBe(1);
  });

  it('is 0 when nothing waits', () => {
    expect(badgeCount([src('sources/a.md', true)], [])).toBe(0);
  });
});
