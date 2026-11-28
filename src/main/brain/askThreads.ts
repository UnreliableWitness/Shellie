import { z } from 'zod';
import {
  ASK_LEFT_BY_QUIT,
  ASK_THREADS_MAX,
  type AskThread,
} from '../../shared/brainAsk';
import { JsonFileStore } from '../usage/JsonFileStore';

// Loose where the shapes are the renderer's own (an answer, its steps): what was saved is given back as it was.
const ExchangeSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    status: z.enum(['running', 'done', 'failed', 'stopped']),
    startedAt: z.number(),
    endedAt: z.number().nullable().optional(),
    answer: z
      .object({
        sessionId: z.string().nullable(),
        answer: z.string(),
        durationMs: z.number(),
        costEur: z.number().nullable(),
        changed: z.boolean(),
      })
      .passthrough()
      .nullable(),
    error: z.string().nullable(),
    refused: z.enum(['cap', 'held']).nullable(),
  })
  .passthrough();
const ThreadSchema = z.object({
  id: z.string(),
  brainId: z.string(),
  taskId: z.string().nullable(),
  startedAt: z.number(),
  current: z.boolean(),
  exchanges: z.array(ExchangeSchema),
});
const FileSchema = z.object({
  version: z.literal(1),
  threads: z.array(ThreadSchema),
});
type File = z.infer<typeof FileSchema>;

/** When a thread was last asked something. */
const lastAsked = (t: AskThread) =>
  Math.max(t.startedAt, ...t.exchanges.map((e) => e.startedAt));

/**
 * What was asked of the brains and what they answered (`brain-asks.json` in the data folder): the renderer owns a
 * thread while the app runs and saves every change here, and gets the threads back at the start. On this
 * computer only: nothing of it goes into a brain's folder.
 */
export class AskThreadStore {
  private readonly store: JsonFileStore<File>;

  constructor(
    file: string,
    /** The ids of the brains that exist: threads of any other are dropped. */
    private readonly brainIds: () => string[],
  ) {
    this.store = new JsonFileStore<File>(
      file,
      FileSchema as unknown as z.ZodType<File>,
      () => ({ version: 1, threads: [] }),
    );
  }

  /** Reads the file; a question that was being answered when Shellie closed could not finish. */
  async load(): Promise<void> {
    await this.store.load();
    const left = this.store.value.threads.some((t) =>
      t.exchanges.some((e) => e.status === 'running'),
    );
    if (!left) return;
    await this.store.update((f) => {
      for (const t of f.threads)
        for (const e of t.exchanges)
          if (e.status === 'running') {
            e.status = 'failed';
            e.error = ASK_LEFT_BY_QUIT;
            e.answer = null;
          }
    });
  }

  list(): AskThread[] {
    return this.store.value.threads as AskThread[];
  }

  /**
   * Replaces what is kept by `threads`, within the limits: no empty thread, none of a brain that is gone, and per
   * brain the current ones plus the most recently asked others up to `ASK_THREADS_MAX`.
   */
  async save(threads: AskThread[]): Promise<void> {
    const brains = new Set(this.brainIds());
    const byBrain = new Map<string, AskThread[]>();
    for (const t of threads) {
      if (t.exchanges.length === 0 || !brains.has(t.brainId)) continue;
      byBrain.set(t.brainId, [...(byBrain.get(t.brainId) ?? []), t]);
    }
    const kept = new Set<AskThread>();
    for (const list of byBrain.values()) {
      const ranked = [...list].sort(
        (a, b) =>
          Number(b.current) - Number(a.current) || lastAsked(b) - lastAsked(a),
      );
      for (const t of ranked.slice(0, ASK_THREADS_MAX)) kept.add(t);
    }
    await this.store.update((f) => {
      f.threads = threads.filter((t) => kept.has(t)) as File['threads'];
    });
  }
}
