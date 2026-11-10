import type { BrainJob } from '../../shared/brain';
import { PENDING } from './bookPass';
import { readConflicts, updateConflicts } from './conflicts';
import type { BrainJobRunner } from './jobs';
import { writeState } from './state';

const DECISION_PAGE = /^decision: (wiki\/decision-[^\s]+\.md)\s*$/m;

/**
 * The settle job's hooks. `promptFor` hands `/settle` the decision kept in brain/conflicts.json; `afterJob` marks
 * the settle done (with the decision page the skill named, and an answer source recorded as captured) or failed
 * (the decision kept for Retry); `resume` queues, at launch, every pending settle whose job was lost.
 * `runner` is read late: the runner is built with these hooks.
 */
export function createSettleHooks(d: {
  brainDir: (brainId: string) => string | null;
  brainIds: () => string[];
  runner: () => Pick<BrainJobRunner, 'enqueue' | 'jobs'>;
  changed: (brainId: string) => void;
  now?: () => Date;
}) {
  const now = d.now ?? (() => new Date());
  return {
    promptFor: async (job: BrainJob): Promise<string | null | undefined> => {
      if (job.kind !== 'settle') return undefined;
      const dir = d.brainDir(job.brainId);
      if (!dir || !job.conflict) return null;
      const rec = (await readConflicts(dir)).conflicts[job.conflict]?.settled;
      return rec ? `/settle ${JSON.stringify(rec.decision)}` : null;
    },

    afterJob: async (job: BrainJob): Promise<void> => {
      if (job.kind !== 'settle' || !job.conflict) return;
      if (job.status !== 'done' && job.status !== 'failed') return;
      const dir = d.brainDir(job.brainId);
      if (!dir) return;
      const id = job.conflict;
      const done = job.status === 'done';
      const file = await updateConflicts(dir, (f) => {
        const rec = f.conflicts[id];
        if (!rec?.settled) return f;
        return {
          ...f,
          conflicts: {
            ...f.conflicts,
            [id]: {
              ...rec,
              settled: {
                ...rec.settled,
                status: done ? 'done' : 'failed',
                page: done
                  ? (DECISION_PAGE.exec(job.result ?? '')?.[1] ?? null)
                  : rec.settled.page,
                error: done ? null : (job.error ?? 'failed'),
              },
            },
          },
        };
      });
      // The settle read the answer: it is folded in, not left for a capture.
      const answer = file.conflicts[id]?.settled?.decision.answer;
      if (done && answer) {
        const at = now().toISOString();
        await writeState(dir, (s) => ({
          ...s,
          captured: {
            ...s.captured,
            [answer]: { at, sessionId: job.sessionId },
          },
        }));
      }
      d.changed(job.brainId);
    },

    resume: async (): Promise<void> => {
      for (const brainId of d.brainIds()) {
        const dir = d.brainDir(brainId);
        if (!dir) continue;
        const inRunner = new Set(
          d
            .runner()
            .jobs(brainId)
            .filter((j) => j.kind === 'settle' && PENDING.has(j.status))
            .map((j) => j.conflict),
        );
        const file = await readConflicts(dir);
        for (const [id, rec] of Object.entries(file.conflicts))
          if (rec.settled?.status === 'pending' && !inRunner.has(id))
            d.runner().enqueue(brainId, 'settle', null, { conflict: id });
      }
    },
  };
}
