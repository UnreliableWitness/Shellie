import { describe, expect, it } from 'vitest';
import type { PrDraft } from '../../shared/prDraft';
import type { AskTabResult } from './askTab';
import {
  PrDrafts,
  type HeadlessResult,
  type PickResult,
  type PrDraftsDeps,
} from './PrDrafts';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const make = (o: Partial<PrDraftsDeps> = {}) => {
  const changes: [string, PrDraft][] = [];
  const events: [string, Record<string, unknown>][] = [];
  const drafts = new PrDrafts({
    pick: async () => ({ reason: 'no-tab' }),
    headless: async () => ({ text: 'Headless text', agent: 'claude' }),
    finish: (_t, _w, text) => text.trim(),
    changed: (_t, ws, d) => changes.push([ws, d]),
    event: (name, props) => events.push([name, props]),
    now: () => 0,
    ...o,
  });
  return { drafts, changes, events };
};

const tabPick = (
  ask: (
    signal: AbortSignal,
    onBlocked: (b: boolean) => void,
  ) => Promise<AskTabResult>,
): PickResult => ({
  tab: { id: 'c1', label: 'Claude Code' },
  agent: 'claude',
  ask,
});

describe('PrDrafts', () => {
  it('writes headless when there is no tab, without a note', async () => {
    const { drafts, events } = make();
    const d = await drafts.write('T', 'home');
    expect(d).toMatchObject({
      status: 'ready',
      source: 'headless',
      text: 'Headless text',
      note: null,
    });
    expect(drafts.get('T')).toEqual({ home: d });
    expect(events).toEqual([
      [
        'pr.summary',
        { ok: true, source: 'headless', reason: 'no-tab', agent: 'claude' },
      ],
    ]);
  });

  it('says why when the tab was there but not asked', async () => {
    const { drafts } = make({ pick: async () => ({ reason: 'busy' }) });
    expect((await drafts.write('T', 'home')).note).toBe(
      'Written without the agent tab: the agent tab was busy.',
    );
  });

  it("uses the tab's answer, and shows the tab while it waits", async () => {
    const answer = deferred<AskTabResult>();
    let blocked: ((b: boolean) => void) | null = null;
    const { drafts, changes } = make({
      pick: async () =>
        tabPick((_s, onBlocked) => {
          blocked = onBlocked;
          return answer.promise;
        }),
      headless: async () => {
        throw new Error('not expected');
      },
    });
    const p = drafts.write('T', 'home');
    await new Promise((r) => setTimeout(r, 0));
    expect(drafts.get('T').home).toMatchObject({
      status: 'asking-tab',
      tab: { label: 'Claude Code' },
    });
    blocked!(true);
    expect(drafts.get('T').home.status).toBe('tab-blocked');
    blocked!(false);
    answer.resolve({ text: ' From the tab ' });
    expect(await p).toMatchObject({
      status: 'ready',
      source: 'tab',
      text: 'From the tab',
    });
    expect(changes.map(([, d]) => d.status)).toEqual([
      'writing',
      'asking-tab',
      'tab-blocked',
      'asking-tab',
      'ready',
    ]);
  });

  it('falls back to headless when the tab gives nothing, saying why', async () => {
    const { drafts, changes, events } = make({
      pick: async () => tabPick(async () => ({ reason: 'no-reply' })),
    });
    const d = await drafts.write('T', 'home');
    expect(d).toMatchObject({
      status: 'ready',
      source: 'headless',
      note: expect.stringContaining('did not answer'),
    });
    expect(changes.map(([, x]) => `${x.status}/${x.source}`)).toContain(
      'writing/headless',
    );
    expect(events[0][1]).toMatchObject({
      source: 'headless',
      reason: 'no-reply',
    });
  });

  it('a tab answer that is empty once tidied falls back too', async () => {
    const { drafts } = make({
      pick: async () => tabPick(async () => ({ text: '   ' })),
    });
    expect(await drafts.write('T', 'home')).toMatchObject({
      source: 'headless',
      text: 'Headless text',
    });
  });

  it('reports a failed headless run with its reason', async () => {
    const { drafts, events } = make({
      headless: async (): Promise<HeadlessResult> => ({
        error: 'Neither Claude Code nor OpenCode was found',
        reason: 'no-agent',
        agent: null,
      }),
    });
    expect(await drafts.write('T', 'home')).toMatchObject({
      status: 'failed',
      error: 'Neither Claude Code nor OpenCode was found',
    });
    expect(events[0][1]).toMatchObject({ ok: false, failure: 'no-agent' });
  });

  it('Skip stops the tab and ignores its late answer', async () => {
    let seen: AbortSignal | null = null;
    const answer = deferred<AskTabResult>();
    const { drafts } = make({
      pick: async () =>
        tabPick((signal) => {
          seen = signal;
          return answer.promise;
        }),
    });
    const p = drafts.write('T', 'home');
    await new Promise((r) => setTimeout(r, 0));
    drafts.skip('T', 'home');
    expect(seen!.aborted).toBe(true);
    answer.resolve({ text: 'Late' });
    await p;
    expect(drafts.get('T').home).toMatchObject({ status: 'skipped', text: '' });
  });

  it('Write again stops the running one', async () => {
    const first = deferred<HeadlessResult>();
    let calls = 0;
    const { drafts } = make({
      headless: async () =>
        ++calls === 1 ? first.promise : { text: 'Second', agent: 'opencode' },
    });
    const a = drafts.write('T', 'home');
    await new Promise((r) => setTimeout(r, 0));
    const b = drafts.write('T', 'home');
    first.resolve({ text: 'First', agent: 'claude' });
    await a;
    expect(await b).toMatchObject({ text: 'Second' });
    expect(drafts.get('T').home.text).toBe('Second');
  });

  it("writes one task's repos one after the other", async () => {
    const order: string[] = [];
    const first = deferred<HeadlessResult>();
    const { drafts } = make({
      headless: async (_t, ws) => {
        order.push(`start:${ws}`);
        const r =
          ws === 'a'
            ? await first.promise
            : { text: ws, agent: 'claude' as const };
        order.push(`end:${ws}`);
        return r;
      },
    });
    const a = drafts.write('T', 'a');
    const b = drafts.write('T', 'b');
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['start:a']);
    first.resolve({ text: 'a', agent: 'claude' });
    await Promise.all([a, b]);
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('keeps an edit, and forgets a task', async () => {
    const { drafts } = make();
    await drafts.write('T', 'home');
    drafts.edit('T', 'home', 'Mine');
    expect(drafts.get('T').home.text).toBe('Mine');
    drafts.forget('T');
    expect(drafts.get('T')).toEqual({});
  });
});
