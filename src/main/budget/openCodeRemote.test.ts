import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeReader } from './openCode';
import {
  createReadHandler,
  OpenCodeRemote,
  type ReadReply,
  type ReadRequest,
  type WorkerLike,
} from './openCodeRemote';

class FakeWorker extends EventEmitter implements WorkerLike {
  sent: ReadRequest[] = [];
  terminated = false;
  postMessage(m: ReadRequest) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  reply(m: ReadReply) {
    this.emit('message', m);
  }
}

const result = { records: [], cursor: 7, found: true };

function setup() {
  const workers: FakeWorker[] = [];
  const remote = new OpenCodeRemote(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  return { remote, workers };
}

describe('OpenCodeRemote', () => {
  it('starts no worker until the first read', () => {
    const { remote, workers } = setup();
    remote.reader('db');
    expect(workers).toHaveLength(0);
  });

  it('sends a read to the worker and resolves with its answer', async () => {
    const { remote, workers } = setup();
    const page = { limit: 10 };
    const read = remote.reader('db', { since: 5 }).read(3, page);
    const sent = workers[0].sent[0];
    expect(sent).toMatchObject({
      file: 'db',
      options: { since: 5 },
      cursor: 3,
      page,
    });
    workers[0].reply({ id: sent.id, result });
    await expect(read).resolves.toEqual(result);
  });

  it('rejects a read the worker failed', async () => {
    const { remote, workers } = setup();
    const read = remote.reader('db').read(0);
    workers[0].reply({
      id: workers[0].sent[0].id,
      error: 'database is locked',
    });
    await expect(read).rejects.toThrow('database is locked');
  });

  it('shares one worker between readers', () => {
    const { remote, workers } = setup();
    void remote.reader('db').read(0);
    void remote.reader('db', { since: 1 }).read(0);
    expect(workers).toHaveLength(1);
  });

  it.each(['error', 'exit'])(
    'rejects waiting reads on a worker %s and starts a new worker for the next read',
    async (event) => {
      const { remote, workers } = setup();
      const read = remote.reader('db').read(0);
      workers[0].emit(event, new Error('died'));
      await expect(read).rejects.toThrow();
      void remote.reader('db').read(0);
      expect(workers).toHaveLength(2);
    },
  );

  it('rejects a read when the worker cannot start', async () => {
    const remote = new OpenCodeRemote(() => {
      throw new Error('no worker');
    });
    await expect(remote.reader('db').read(0)).rejects.toThrow('no worker');
  });

  it('terminates the worker on stop and refuses later reads', async () => {
    const { remote, workers } = setup();
    const waiting = remote.reader('db').read(0);
    remote.stop();
    expect(workers[0].terminated).toBe(true);
    await expect(waiting).rejects.toThrow();
    await expect(remote.reader('db').read(0)).rejects.toThrow();
  });
});

describe('createReadHandler', () => {
  const request = (over: Partial<ReadRequest> = {}): ReadRequest => ({
    id: 1,
    file: 'db',
    options: {},
    cursor: 0,
    ...over,
  });

  it('answers from a real reader', () => {
    const handle = createReadHandler();
    expect(
      handle(request({ file: '/no/such/opencode.db', cursor: 4 })),
    ).toEqual({ id: 1, result: { records: [], cursor: 4, found: false } });
  });

  it('keeps one reader per database and options, so it remembers what it read', () => {
    const make = vi.fn(
      () => ({ read: () => result }) as unknown as OpenCodeReader,
    );
    const handle = createReadHandler(make);
    handle(request());
    handle(request({ id: 2 }));
    handle(request({ id: 3, options: { since: 9 } }));
    expect(make).toHaveBeenCalledTimes(2);
  });

  it('turns a failed read into an error answer', () => {
    const handle = createReadHandler(
      () =>
        ({
          read: () => {
            throw new Error('database is locked');
          },
        }) as unknown as OpenCodeReader,
    );
    expect(handle(request())).toEqual({ id: 1, error: 'database is locked' });
  });
});
