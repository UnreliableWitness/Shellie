import { errorMessage } from '../../shared/errors';
import { OpenCodeReader } from './openCode';

type ReaderOptions = { since?: number };
type ReadArgs = Parameters<OpenCodeReader['read']>;
export type OpenCodeReadResult = ReturnType<OpenCodeReader['read']>;
/** What the budget and the ledger need of a reader: the worker's answers later, a test's at once. */
export type OpenCodeRead = (
  ...args: ReadArgs
) => OpenCodeReadResult | Promise<OpenCodeReadResult>;

export type ReadRequest = {
  id: number;
  file: string;
  options: ReaderOptions;
  cursor: number;
  page?: ReadArgs[1];
};
export type ReadReply =
  | { id: number; result: OpenCodeReadResult }
  | { id: number; error: string };

/** The subset of a worker_threads Worker used here. */
export type WorkerLike = {
  postMessage(message: ReadRequest): void;
  on(event: 'message', listener: (reply: ReadReply) => void): unknown;
  on(event: 'error' | 'exit', listener: (arg: unknown) => void): unknown;
  terminate(): unknown;
};

/** The worker's side: one reader per database and options, so each keeps what it has already read. */
export function createReadHandler(
  make: (file: string, options: ReaderOptions) => OpenCodeReader = (f, o) =>
    new OpenCodeReader(f, o),
): (request: ReadRequest) => ReadReply {
  const readers = new Map<string, OpenCodeReader>();
  return (m) => {
    try {
      const key = `${m.file}\0${m.options.since ?? ''}`;
      let reader = readers.get(key);
      if (!reader) readers.set(key, (reader = make(m.file, m.options)));
      return { id: m.id, result: reader.read(m.cursor, m.page) };
    } catch (e) {
      return { id: m.id, error: errorMessage(e) };
    }
  };
}

/**
 * OpenCode's `message` table has no index on `time_updated`, so a read scans the whole table (over a second on
 * Windows with 19k messages), and node:sqlite is synchronous. Reads therefore run in a worker thread: on the main
 * process they froze the whole window. The worker starts on the first read and again after it dies.
 */
export class OpenCodeRemote {
  private worker: WorkerLike | null = null;
  private nextId = 0;
  private stopped = false;
  private readonly waiting = new Map<
    number,
    {
      resolve: (r: OpenCodeReadResult) => void;
      reject: (e: Error) => void;
    }
  >();

  constructor(private readonly spawn: () => WorkerLike) {}

  reader(file: string, options: ReaderOptions = {}) {
    return {
      read: (cursor: number, page?: ReadArgs[1]) =>
        new Promise<OpenCodeReadResult>((resolve, reject) => {
          if (this.stopped) throw new Error('The OpenCode worker has stopped');
          const worker = this.current();
          const id = ++this.nextId;
          this.waiting.set(id, { resolve, reject });
          worker.postMessage({ id, file, options, cursor, page });
        }),
    };
  }

  stop(): void {
    this.stopped = true;
    this.worker?.terminate();
    this.worker = null;
    this.failWaiting(new Error('The OpenCode worker has stopped'));
  }

  private current(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    const died = (reason: unknown) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.failWaiting(
        reason instanceof Error
          ? reason
          : new Error('The OpenCode worker exited'),
      );
    };
    worker.on('message', (reply) => this.answer(reply));
    worker.on('error', died);
    worker.on('exit', died);
    this.worker = worker;
    return worker;
  }

  private answer(reply: ReadReply) {
    const entry = this.waiting.get(reply.id);
    if (!entry) return;
    this.waiting.delete(reply.id);
    if ('error' in reply) entry.reject(new Error(reply.error));
    else entry.resolve(reply.result);
  }

  private failWaiting(error: Error) {
    for (const { reject } of this.waiting.values()) reject(error);
    this.waiting.clear();
  }
}
