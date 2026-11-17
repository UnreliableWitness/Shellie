import { describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_FONT,
  followColorScheme,
  onScaleChange,
  terminalOptions,
} from './terminalSetup';
import { MIN_CONTRAST, TERMINAL_THEMES } from './terminalTheme';
import { setTestColorScheme } from './testColorScheme';

describe('terminalOptions', () => {
  it('tells xterm about ConPTY on Windows', () => {
    expect(terminalOptions(22631).windowsPty).toEqual({
      backend: 'conpty',
      buildNumber: 22631,
    });
  });

  it('leaves windowsPty unset elsewhere', () => {
    expect(terminalOptions(null)).not.toHaveProperty('windowsPty');
  });

  it('draws box and block characters itself and uses only system terminal fonts', () => {
    const o = terminalOptions(null);
    expect(o.customGlyphs).toBe(true);
    expect(o.fontFamily).toBe(TERMINAL_FONT);
    expect(TERMINAL_FONT).toMatch(/^'Cascadia Mono', Consolas,/);
    expect(TERMINAL_FONT).not.toMatch(/JetBrains/);
  });

  it('starts a terminal in the scheme on screen', () => {
    expect(terminalOptions(null).theme).toBe(TERMINAL_THEMES.dark);
    expect(terminalOptions(null).minimumContrastRatio).toBe(MIN_CONTRAST.dark);
    setTestColorScheme('light');
    expect(terminalOptions(null).theme).toBe(TERMINAL_THEMES.light);
    expect(terminalOptions(null).minimumContrastRatio).toBe(MIN_CONTRAST.light);
  });
});

describe('followColorScheme', () => {
  it('re-colours the terminal on a switch, then reports it, until unsubscribed', () => {
    const t = { options: {} };
    const seen: unknown[] = [];
    const off = followColorScheme(t, (s) => seen.push([s, { ...t.options }]));
    setTestColorScheme('light');
    const light = {
      theme: TERMINAL_THEMES.light,
      minimumContrastRatio: MIN_CONTRAST.light,
    };
    expect(t.options).toEqual(light);
    // Reported after the re-colour, so a program asking for the background then gets the new one.
    expect(seen).toEqual([['light', light]]);
    off();
    setTestColorScheme('dark');
    expect(t.options).toEqual(light);
    expect(seen).toHaveLength(1);
  });
});

describe('onScaleChange', () => {
  it('reports each scale factor change, asking again for the new ratio, until unsubscribed', () => {
    const queries: { media: string; listeners: Set<() => void> }[] = [];
    const had = window.matchMedia;
    window.matchMedia = ((media: string) => {
      const q = { media, listeners: new Set<() => void>() };
      queries.push(q);
      return {
        addEventListener: (_: string, l: () => void) => q.listeners.add(l),
        removeEventListener: (_: string, l: () => void) =>
          q.listeners.delete(l),
      };
    }) as never;
    const ratio = vi.spyOn(window, 'devicePixelRatio', 'get');
    try {
      ratio.mockReturnValue(1);
      const changed = vi.fn();
      const off = onScaleChange(changed);
      expect(queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)']);
      ratio.mockReturnValue(1.5);
      for (const l of queries[0].listeners) l();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(queries[0].listeners.size).toBe(0);
      expect(queries[1].media).toBe('(resolution: 1.5dppx)');
      off();
      expect(queries[1].listeners.size).toBe(0);
    } finally {
      ratio.mockRestore();
      window.matchMedia = had;
    }
  });
});
