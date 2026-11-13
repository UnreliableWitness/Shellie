import { describe, expect, it } from 'vitest';
import type { BrainJob } from '../../shared/brain';
import {
  jobSubject,
  jobTarget,
  jobTargetOpts,
  parseJobSubject,
} from './brainCommits';

const job = (o: Partial<BrainJob>) =>
  ({ kind: 'sync', source: null, ...o }) as BrainJob;

describe('job subjects', () => {
  it('names the source, target or conflict id, and reads it back to queue the same job', () => {
    const cases = [
      job({ kind: 'capture', source: 'sources/a.md' }),
      job({ kind: 'write', target: 'chapter:Orders' }),
      job({ kind: 'settle', conflict: 'c1' }),
      job({ kind: 'lint' }),
    ];
    expect(cases.map(jobSubject)).toEqual([
      'Brain: capture sources/a.md',
      'Brain: write chapter:Orders',
      'Brain: settle c1',
      'Brain: lint',
    ]);
    for (const j of cases) {
      const ref = parseJobSubject(jobSubject(j));
      expect(ref).toEqual({
        kind: j.kind,
        source: j.source,
        target: jobTarget(j),
      });
      expect(jobTargetOpts(j.kind, ref?.target ?? null)).toEqual({
        ...(j.target ? { target: j.target } : {}),
        ...(j.conflict ? { conflict: j.conflict } : {}),
      });
    }
  });

  it('gives no target options without a target or for a source job', () => {
    expect(jobTargetOpts('write', null)).toEqual({});
    expect(jobTargetOpts('capture', 'x')).toEqual({});
  });
});
