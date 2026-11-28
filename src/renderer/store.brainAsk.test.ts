import { beforeEach, describe, expect, it } from 'vitest';
import type { AskOutcome } from '../shared/brainAsk';
import type { TaskView } from '../shared/types';
import { useStore } from './store';
import { installFakeApi } from './test-helpers/fakeApi';

const answer = (sessionId: string): AskOutcome => ({
  ok: true,
  answer: {
    sessionId,
    answer: 'Semicolons.',
    durationMs: 18_000,
    costEur: null,
    changed: false,
  },
});

let asked: [string, string, string, string | null][];
let stopped: string[];
let settle: ((o: AskOutcome) => void)[];
let fail: ((e: Error) => void)[];

beforeEach(() => {
  asked = [];
  stopped = [];
  settle = [];
  fail = [];
  installFakeApi({
    'brain:ask': (brainId, taskId, question, resume) => {
      asked.push([brainId, taskId, question, resume]);
      return new Promise<AskOutcome>((res, rej) => {
        settle.push(res);
        fail.push(rej);
      });
    },
    'brain:askStop': (taskId) => {
      stopped.push(taskId);
    },
  });
  useStore.setState({ brainAsksByTask: {}, brainAskOpenByTask: {} });
});

const thread = (taskId = 't1') =>
  useStore.getState().brainAsksByTask[taskId] ?? [];

describe("a task's questions to its brain", () => {
  it('adds a running exchange and opens the answer view', () => {
    void useStore.getState().askBrain('t1', 'b1', ' Why? ', 'typed');
    expect(thread()).toMatchObject([
      { question: 'Why?', status: 'running', answer: null, error: null },
    ]);
    expect(useStore.getState().brainAskOpenByTask.t1).toBe(true);
    expect(asked).toEqual([['b1', 't1', 'Why?', null]]);
  });

  it('fills in the answer with no component mounted', async () => {
    const p = useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    settle[0](answer('s1'));
    await p;
    expect(thread()).toMatchObject([
      { status: 'done', answer: { sessionId: 's1', answer: 'Semicolons.' } },
    ]);
  });

  it('keeps a refusal with its reason', async () => {
    const p = useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    settle[0]({ ok: false, refused: 'cap', message: 'limit' });
    await p;
    expect(thread()).toMatchObject([
      { status: 'failed', error: 'limit', refused: 'cap', answer: null },
    ]);
  });

  it('keeps the message of a call that failed', async () => {
    const p = useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    fail[0](new Error('boom'));
    await p;
    expect(thread()).toMatchObject([
      { status: 'failed', error: 'boom', refused: null },
    ]);
  });

  it('keeps a stopped question as stopped, with when it ended', async () => {
    const p = useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    settle[0]({ ok: false, refused: null, message: 'Stopped', stopped: true });
    await p;
    expect(thread()).toMatchObject([
      { status: 'stopped', error: null, endedAt: expect.any(Number) },
    ]);
  });

  it('asks again in the place of the exchange it replaces, on the session before it', async () => {
    const first = useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    settle[0](answer('s1'));
    await first;
    const second = useStore.getState().askBrain('t1', 'b1', 'How?', 'typed');
    fail[1](new Error('boom'));
    await second;
    const failed = thread()[1];
    void useStore.getState().askBrain('t1', 'b1', 'How?', 'typed', failed.id);
    expect(thread()).toHaveLength(2);
    expect(thread()[1]).toMatchObject({ question: 'How?', status: 'running' });
    expect(thread()[1].id).not.toBe(failed.id);
    expect(asked[2]).toEqual(['b1', 't1', 'How?', 's1']);
  });

  it('forgets what the agent of the question before was doing', () => {
    useStore.getState().setAskProgress('brain:t1', {
      steps: [{ kind: 'read', label: 'Read wiki/a.md' }],
      earlier: 0,
      text: 'The old answer',
    });
    void useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    expect(useStore.getState().askProgress['brain:t1']).toBeUndefined();
  });

  it('does nothing for a second question while one runs, or for an empty one', () => {
    void useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    void useStore.getState().askBrain('t1', 'b1', 'Again?', 'typed');
    void useStore.getState().askBrain('t2', 'b1', '   ', 'typed');
    expect(thread()).toHaveLength(1);
    expect(thread('t2')).toHaveLength(0);
    expect(asked).toHaveLength(1);
  });

  it('a follow-up resumes the last answered session', async () => {
    const first = useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    settle[0](answer('s1'));
    await first;
    const second = useStore
      .getState()
      .askBrain('t1', 'b1', 'And then?', 'follow-up');
    settle[1]({ ok: false, refused: null, message: 'Stopped' });
    await second;
    void useStore.getState().askBrain('t1', 'b1', 'Third?', 'follow-up');
    expect(asked.map((a) => a[3])).toEqual([null, 's1', 's1']);
    expect(thread()).toHaveLength(3);
  });

  it('stops the running question', () => {
    void useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    useStore.getState().stopBrainAsk('t1');
    expect(stopped).toEqual(['t1']);
  });

  it('closes and opens the answer view without losing the thread', async () => {
    const p = useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    settle[0](answer('s1'));
    await p;
    useStore.getState().setBrainAskOpen('t1', false);
    expect(useStore.getState().brainAskOpenByTask.t1).toBe(false);
    expect(thread()).toHaveLength(1);
  });

  it("drops a removed task's thread", async () => {
    const p = useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    settle[0](answer('s1'));
    await p;
    useStore.getState().setTasks([{ id: 't2' } as unknown as TaskView]);
    expect(useStore.getState().brainAsksByTask).toEqual({});
    expect(useStore.getState().brainAskOpenByTask).toEqual({});
  });
});
