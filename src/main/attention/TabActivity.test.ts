import { describe, expect, it } from 'vitest';
import { TabActivity } from './TabActivity';

const make = () => {
  let now = 1000;
  const a = new TabActivity(() => now);
  return { a, tick: (ms: number) => (now += ms) };
};

describe('TabActivity', () => {
  it('knows the last state, when it came and how long the tab was quiet', () => {
    const { a, tick } = make();
    a.spawned('t');
    expect(a.view('t')).toEqual({
      state: null,
      stateAt: null,
      typed: false,
      quietFor: 0,
    });
    a.status('t', 'working');
    tick(500);
    a.output('t');
    a.status('t', 'done');
    tick(2500);
    expect(a.view('t')).toEqual({
      state: 'done',
      stateAt: 1500,
      typed: false,
      quietFor: 2500,
    });
  });

  it('sees unsent text: typed after printable input, cleared by Enter or Ctrl+C', () => {
    const { a } = make();
    a.spawned('t');
    a.input('t', 'half a pro');
    expect(a.view('t')?.typed).toBe(true);
    a.input('t', '\r');
    expect(a.view('t')?.typed).toBe(false);
    a.input('t', 'x');
    a.input('t', '\x03');
    expect(a.view('t')?.typed).toBe(false);
    // Arrow keys and focus reports change nothing.
    a.input('t', '\x1b[A\x1b[I');
    expect(a.view('t')?.typed).toBe(false);
  });

  it('starts clean when the tab starts again, and forgets it on exit', () => {
    const { a } = make();
    a.spawned('t');
    a.status('t', 'working');
    a.input('t', 'abc');
    a.spawned('t');
    expect(a.view('t')).toMatchObject({ state: null, typed: false });
    a.exit('t');
    expect(a.view('t')).toBeNull();
  });

  it('tells listeners about every state until they unsubscribe', () => {
    const { a } = make();
    const seen: string[] = [];
    const off = a.onState((id, s) => seen.push(`${id}:${s}`));
    a.status('t', 'working');
    a.status('u', 'done');
    off();
    a.status('t', 'done');
    expect(seen).toEqual(['t:working', 'u:done']);
  });
});
