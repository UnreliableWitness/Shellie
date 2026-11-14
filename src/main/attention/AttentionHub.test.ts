import { beforeEach, describe, expect, it } from 'vitest';
import {
  AttentionHub,
  notificationBody,
  type HubTerminal,
} from './AttentionHub';

const ESC = '\x1b';
const BEL = '\x07';
const b64 = (s: string) => Buffer.from(s).toString('base64');

let now: number;
let writes: [string, string][];
let shown: {
  title: string;
  body: string;
  onClick: () => void;
  closed: boolean;
}[];
let badge: number;
let opened: [string, string][];
let terms: Record<string, HubTerminal>;
let writeThrows: boolean;
let statuses: [string, string][];

const hub = () =>
  new AttentionHub({
    now: () => now,
    write: (id, d) => {
      if (writeThrows) throw new Error(`Unknown terminal ${id}`);
      writes.push([id, d]);
    },
    terminal: (id) => terms[id] ?? null,
    notifyOnDone: () => true,
    show: (n) => {
      const rec = { ...n, closed: false };
      shown.push(rec);
      return {
        close: () => {
          rec.closed = true;
        },
      };
    },
    setBadgeCount: (n) => {
      badge = n;
    },
    changed: () => undefined,
    open: (taskId, id) => opened.push([taskId, id]),
    status: (id, state) => statuses.push([id, state]),
  });

beforeEach(() => {
  now = 0;
  writes = [];
  shown = [];
  badge = -1;
  opened = [];
  writeThrows = false;
  statuses = [];
  terms = {
    c1: {
      taskId: 'T',
      taskTitle: '42 Fix login',
      label: 'Claude Code',
      kind: 'claude',
    },
    o1: {
      taskId: 'T',
      taskTitle: '42 Fix login',
      label: 'OpenCode',
      kind: 'opencode',
    },
    s1: {
      taskId: 'T',
      taskTitle: '42 Fix login',
      label: 'Copilot CLI',
      kind: 'copilot',
    },
  };
});

describe('AttentionHub', () => {
  it('answers the probe and survives a terminal that is gone', () => {
    const h = hub();
    h.data('c1', `${ESC}]7501;?${BEL}`);
    expect(writes).toEqual([['c1', `${ESC}]7501;?${BEL}`]]);
    writeThrows = true;
    expect(() => h.data('c1', `${ESC}]7501;?${BEL}`)).not.toThrow();
  });

  it('turns Claude status into a notification, badge and click-through', () => {
    const h = hub();
    h.data(
      'c1',
      `${ESC}]7501;state=blocked:app=claude-code:kind=permission:msg=${b64('approve Bash: ls')}${BEL}`,
    );
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('42 Fix login');
    expect(shown[0].body).toBe(
      'Claude Code needs permission: approve Bash: ls',
    );
    expect(badge).toBe(1);
    shown[0].onClick();
    expect(opened).toEqual([['T', 'c1']]);
  });

  it('rings once per 10 s for a terminal without status, never for Claude or OpenCode', () => {
    const h = hub();
    h.data('s1', BEL);
    now = 5000;
    h.data('s1', BEL);
    expect(h.snapshot().s1).toMatchObject({ reason: 'blocked', kind: 'bell' });
    expect(shown.map((s) => s.body)).toEqual(['Copilot CLI rang the bell']);
    h.data('o1', BEL);
    h.data('c1', `${ESC}]7501;state=idle:app=claude-code${BEL}`);
    h.data('c1', BEL);
    expect(Object.keys(h.snapshot())).toEqual(['s1']);
  });

  it('passes each program status on', () => {
    const h = hub();
    h.data('c1', `${ESC}]7501;state=working:app=claude-code${BEL}`);
    h.data('c1', `${ESC}]7501;state=bogus${BEL}`);
    h.data('c1', `${ESC}]7501;state=idle:app=claude-code${BEL}`);
    expect(statuses).toEqual([
      ['c1', 'working'],
      ['c1', 'idle'],
    ]);
  });

  it('accepts receiver signals only for known terminals', () => {
    const h = hub();
    expect(h.signal('nope', { state: 'blocked' })).toBe(false);
    expect(h.signal('o1', { state: 'blocked', kind: 'question' })).toBe(true);
    expect(shown[0].body).toBe('OpenCode has a question');
  });

  it('retain and exit clear badge and close the notification', () => {
    const h = hub();
    h.signal('o1', { state: 'blocked' });
    h.signal('s1', { state: 'done' });
    expect(badge).toBe(2);
    h.retain(new Set(['s1']));
    expect(badge).toBe(1);
    expect(shown[0].closed).toBe(true);
    h.exit('s1');
    expect(badge).toBe(0);
    expect(shown[1].closed).toBe(true);
  });
});

describe('notificationBody', () => {
  it('words each reason', () => {
    expect(
      notificationBody('X', {
        reason: 'blocked',
        kind: 'permission',
        since: 0,
      }),
    ).toBe('X needs permission');
    expect(notificationBody('X', { reason: 'blocked', since: 0 })).toBe(
      'X is waiting for you',
    );
    expect(notificationBody('X', { reason: 'done', since: 0 })).toBe(
      'X finished',
    );
    expect(
      notificationBody('X', { reason: 'done', message: 'm', since: 0 }),
    ).toBe('X finished: m');
  });

  describe('muteNextDone', () => {
    const osc = (state: string, extra = '') =>
      `${ESC}]7501;state=${state}:app=claude-code${extra}${BEL}`;

    it('does not notify or badge the turn Shellie asked for, then notifies again', () => {
      const h = hub();
      h.muteNextDone('c1');
      h.data('c1', osc('working'));
      h.data('c1', osc('done'));
      expect(shown).toHaveLength(0);
      expect(badge).not.toBe(1);
      h.data('c1', osc('working'));
      h.data('c1', osc('done'));
      expect(shown).toHaveLength(1);
    });

    it('still notifies a permission prompt during the muted turn, and clears it at its end', () => {
      const h = hub();
      h.muteNextDone('o1');
      expect(h.signal('o1', { state: 'blocked', kind: 'permission' })).toBe(
        true,
      );
      expect(shown).toHaveLength(1);
      expect(badge).toBe(1);
      h.signal('o1', { state: 'done' });
      expect(badge).toBe(0);
      expect(shown).toHaveLength(1);
    });

    it('reports every state to observed, muted or not, from both paths', () => {
      const seen: [string, string][] = [];
      const h = new AttentionHub({
        now: () => now,
        write: () => undefined,
        terminal: (id) => terms[id] ?? null,
        notifyOnDone: () => true,
        show: () => ({ close: () => undefined }),
        setBadgeCount: () => undefined,
        changed: () => undefined,
        open: () => undefined,
        observed: (id, st) => seen.push([id, st]),
      });
      h.muteNextDone('c1');
      h.data('c1', osc('done'));
      h.signal('o1', { state: 'working' });
      expect(seen).toEqual([
        ['c1', 'done'],
        ['o1', 'working'],
      ]);
    });

    it('unmute and exit drop the mute', () => {
      const h = hub();
      h.muteNextDone('c1');
      h.unmute('c1');
      h.data('c1', osc('done'));
      expect(shown).toHaveLength(1);
      h.muteNextDone('o1');
      h.exit('o1');
      h.signal('o1', { state: 'done' });
      expect(shown).toHaveLength(2);
    });
  });
});
