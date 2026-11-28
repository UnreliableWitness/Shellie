import { beforeEach, describe, expect, it } from 'vitest';
import type { AskOutcome, AskThread } from '../shared/brainAsk';
import type { TaskView } from '../shared/types';
import { askThreadsToSave, useStore } from './store';
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

let asked: [string, string | null, string, string | null][];
let keys: string[];
let resumeAgents: (string | null)[];
let stopped: string[];
let settle: ((o: AskOutcome) => void)[];
let fail: ((e: Error) => void)[];

beforeEach(() => {
  asked = [];
  keys = [];
  resumeAgents = [];
  stopped = [];
  settle = [];
  fail = [];
  installFakeApi({
    'brain:ask': (brainId, taskId, question, resume, key, resumeAgent) => {
      asked.push([brainId, taskId, question, resume]);
      keys.push(key);
      resumeAgents.push(resumeAgent);
      return new Promise<AskOutcome>((res, rej) => {
        settle.push(res);
        fail.push(rej);
      });
    },
    'brain:askStop': (taskId) => {
      stopped.push(taskId);
    },
  });
  useStore.setState({
    brainAsksByTask: {},
    brainAskOpenByTask: {},
    brainAskThread: {},
    brainAskEarlier: [],
  });
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

  it("keeps a removed task's thread among the earlier ones", async () => {
    const p = useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    settle[0](answer('s1'));
    await p;
    useStore.getState().setTasks([{ id: 't2' } as unknown as TaskView]);
    expect(useStore.getState().brainAsksByTask).toEqual({});
    expect(useStore.getState().brainAskOpenByTask).toEqual({});
    expect(useStore.getState().brainAskEarlier).toMatchObject([
      { brainId: 'b1', taskId: 't1', current: false },
    ]);
  });

  it("asks from the brain's own page without a task, under the page's key", () => {
    void useStore.getState().askBrain('brain:b1', 'b1', 'Why?', 'typed');
    expect(asked).toEqual([['b1', null, 'Why?', null]]);
    expect(keys).toEqual(['brain:b1']);
    useStore.getState().stopBrainAsk('brain:b1');
    expect(stopped).toEqual(['brain:b1']);
  });

  it('passes the agent of the answer a follow-up continues', async () => {
    const first = useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    settle[0]({
      ok: true,
      answer: {
        ...(answer('ses_1') as { answer: object }).answer,
        agent: 'opencode',
      },
    } as AskOutcome);
    await first;
    void useStore.getState().askBrain('t1', 'b1', 'And?', 'follow-up');
    expect(resumeAgents).toEqual([null, 'opencode']);
  });

  it('takes a kept thread in once, however often it is given', () => {
    const kept: AskThread = {
      id: 'a',
      brainId: 'b1',
      taskId: 't1',
      startedAt: 5,
      current: true,
      exchanges: [
        {
          id: 'e1',
          question: 'Kept?',
          status: 'done',
          startedAt: 5,
          answer: null,
          error: null,
          refused: null,
        },
      ],
    };
    const other = { ...kept, id: 'b', current: false };
    useStore.getState().loadBrainThreads([kept, other]);
    useStore.getState().loadBrainThreads([kept, other]);
    expect(thread()).toHaveLength(1);
    expect(useStore.getState().brainAskEarlier.map((t) => t.id)).toEqual(['b']);
  });

  it('starts a new question: the thread so far is kept as an earlier one', async () => {
    const p = useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    settle[0](answer('s1'));
    await p;
    useStore.getState().newBrainQuestion('t1');
    expect(thread()).toEqual([]);
    const [earlier] = useStore.getState().brainAskEarlier;
    expect(earlier).toMatchObject({
      brainId: 'b1',
      taskId: 't1',
      current: false,
      exchanges: [{ question: 'Why?' }],
    });
    // The next question is a new conversation.
    void useStore.getState().askBrain('t1', 'b1', 'Other?', 'typed');
    expect(asked[1][3]).toBe(null);
    expect(useStore.getState().brainAskThread.t1.id).not.toBe(earlier.id);
  });

  it('starts no new question while an answer is coming, or from an empty thread', () => {
    useStore.getState().newBrainQuestion('t1');
    expect(useStore.getState().brainAskEarlier).toEqual([]);
    void useStore.getState().askBrain('t1', 'b1', 'Why?', 'typed');
    useStore.getState().newBrainQuestion('t1');
    expect(thread()).toHaveLength(1);
    expect(useStore.getState().brainAskEarlier).toEqual([]);
  });

  it('gets an earlier thread back, and files the current one in its place', async () => {
    const a = useStore.getState().askBrain('t1', 'b1', 'First?', 'typed');
    settle[0](answer('s1'));
    await a;
    useStore.getState().newBrainQuestion('t1');
    const b = useStore.getState().askBrain('t1', 'b1', 'Second?', 'typed');
    settle[1](answer('s2'));
    await b;
    const first = useStore.getState().brainAskEarlier[0];
    useStore.getState().openBrainThread('t1', first.id);
    expect(thread().map((e) => e.question)).toEqual(['First?']);
    expect(useStore.getState().brainAskThread.t1.id).toBe(first.id);
    expect(
      useStore.getState().brainAskEarlier.map((t) => t.exchanges[0].question),
    ).toEqual(['Second?']);
    expect(useStore.getState().brainAskOpenByTask.t1).toBe(true);
    // A follow-up there continues that thread's own session.
    void useStore.getState().askBrain('t1', 'b1', 'More?', 'follow-up');
    expect(asked[2][3]).toBe('s1');
  });

  it('takes the kept threads in at the start, without touching what was asked meanwhile', async () => {
    void useStore.getState().askBrain('t1', 'b1', 'Now?', 'typed');
    const kept = (
      id: string,
      taskId: string | null,
      current: boolean,
    ): AskThread => ({
      id,
      brainId: 'b1',
      taskId,
      startedAt: 5,
      current,
      exchanges: [
        {
          id: 'ask1',
          question: `Kept ${id}`,
          status: 'done',
          startedAt: 5,
          answer: null,
          error: null,
          refused: null,
        },
      ],
    });
    useStore
      .getState()
      .loadBrainThreads([
        kept('a', 't1', true),
        kept('b', 't2', true),
        kept('c', null, true),
        kept('d', 't2', false),
      ]);
    const s = useStore.getState();
    // t1 asked before the load came back: its kept thread is an earlier one.
    expect(thread().map((e) => e.question)).toEqual(['Now?']);
    expect(thread('t2').map((e) => e.question)).toEqual(['Kept b']);
    expect(thread('brain:b1').map((e) => e.question)).toEqual(['Kept c']);
    expect(s.brainAskThread.t2.id).toBe('b');
    expect(s.brainAskEarlier.map((t) => t.id).sort()).toEqual(['a', 'd']);
    // Everything, current ones marked, for main to keep.
    expect(
      askThreadsToSave(s)
        .map((t) => `${t.id}:${t.current}`)
        .filter((x) => !x.startsWith('th')),
    ).toEqual(
      expect.arrayContaining(['b:true', 'c:true', 'a:false', 'd:false']),
    );
    expect(askThreadsToSave(s).filter((t) => t.current)).toHaveLength(3);
  });
});
